import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import Squire from "squire-rte";
import { sanitizeComposeFragment } from "@/lib/sanitize";

/**
 * The composer's rich-text surface: a headless Squire editor (Fastmail's contenteditable engine —
 * cross-engine normalization, paste handling, undo/redo) under our own toolbar + styling, so the
 * design language stays ours. Squire is treated as uncontrolled-with-initial: the composer remounts
 * per session (mounted only while `composeOpen()`), so we seed `props.html` once on mount and emit
 * every change back through `props.onInput` — the compose store stays canonical. Everything entering
 * the editor (pasted clipboard HTML and the seeded reply/forward quote) is sanitized at the editor
 * boundary via `sanitizeComposeFragment`; the send path sanitizes again authoritatively.
 */
export function RichTextEditor(props: {
  html: string;
  onInput: (html: string) => void;
  ariaLabel: string;
  /** Gates the toolbar + editing while a submit is in flight. */
  disabled?: boolean;
}) {
  let editorEl: HTMLDivElement | undefined;
  let linkInput: HTMLInputElement | undefined;
  let squire: Squire | undefined;
  // The selection captured when the link form opens — focus moves to the URL input, so we restore
  // this range before applying the link rather than letting Squire link an empty cursor.
  let savedLinkRange: Range | undefined;

  const [bold, setBold] = createSignal(false);
  const [italic, setItalic] = createSignal(false);
  const [unordered, setUnordered] = createSignal(false);
  const [ordered, setOrdered] = createSignal(false);
  const [linkOpen, setLinkOpen] = createSignal(false);
  const [linkUrl, setLinkUrl] = createSignal("");

  // Reflect the formatting at the cursor onto the toolbar's pressed states. Squire's hasFormat
  // matches a specific tag, so check both the semantic and presentational spellings (B/STRONG,
  // I/EM) it or pasted content may produce.
  function refreshState(): void {
    const s = squire;
    if (!s) return;
    setBold(s.hasFormat("B") || s.hasFormat("STRONG"));
    setItalic(s.hasFormat("I") || s.hasFormat("EM"));
    setUnordered(s.hasFormat("UL"));
    setOrdered(s.hasFormat("OL"));
  }

  onMount(() => {
    if (!editorEl) return;
    const editor = new Squire(editorEl, {
      blockTag: "div",
      // Clean everything at the boundary: paste, drag-drop, and our own setHTML seed all route here.
      sanitizeToDOMFragment: (html: string) => sanitizeComposeFragment(html),
    });
    squire = editor;
    if (props.html) editor.setHTML(props.html);
    editor.addEventListener("input", () => props.onInput(editor.getHTML()));
    // pathChange fires as the cursor moves across formatting boundaries; keep the toolbar in sync.
    editor.addEventListener("pathChange", refreshState);
    editor.addEventListener("select", refreshState);
    refreshState();
  });

  onCleanup(() => squire?.destroy());

  // Make `disabled` real: toggle the contenteditable off during an in-flight submit so the body
  // can't be edited after currentDraftCreate has already snapshotted it (the toolbar is gated
  // separately via run()/openLink()). Squire keeps its document/root listeners regardless, so
  // flipping the attribute back on restores editing cleanly.
  createEffect(() => {
    if (editorEl) editorEl.contentEditable = props.disabled ? "false" : "true";
  });

  // Apply a Squire command, then re-sync the toolbar, push the new HTML, and return focus to the
  // editor (the toolbar button took it). Squire's own key handlers (Cmd/Ctrl+B/I) route through the
  // same input event, so they stay in sync without extra wiring.
  function run(command: (s: Squire) => void): void {
    const s = squire;
    if (!s || props.disabled) return;
    command(s);
    s.focus();
    props.onInput(s.getHTML());
    refreshState();
  }

  function openLink(): void {
    const s = squire;
    if (!s || props.disabled) return;
    savedLinkRange = s.getSelection();
    setLinkUrl("");
    setLinkOpen(true);
    queueMicrotask(() => linkInput?.focus());
  }

  function closeLink(): void {
    setLinkOpen(false);
    setLinkUrl("");
    savedLinkRange = undefined;
    squire?.focus();
  }

  // Accept only http(s)/mailto; a bare "example.com" is promoted to https. Anything else (notably
  // javascript:) fails to parse and is rejected — the send-path sanitizer is the backstop regardless.
  function normalizeUrl(raw: string): string | null {
    const value = raw.trim();
    if (!value) return null;
    const candidate = /^(https?:|mailto:)/i.test(value) ? value : `https://${value}`;
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
        return candidate;
      }
    } catch {
      // fall through
    }
    return null;
  }

  function applyLink(): void {
    const s = squire;
    const url = normalizeUrl(linkUrl());
    if (!s || !url) return;
    if (savedLinkRange) s.setSelection(savedLinkRange);
    s.makeLink(url);
    setLinkOpen(false);
    setLinkUrl("");
    savedLinkRange = undefined;
    s.focus();
    props.onInput(s.getHTML());
    refreshState();
  }

  function onLinkKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      applyLink();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeLink();
    }
  }

  // Keep the editor's selection alive when a toolbar control is pressed with the mouse: without this
  // the mousedown would move focus out of the contenteditable and collapse the selection before the
  // command runs. Keyboard activation is unaffected (it doesn't fire mousedown).
  function keepSelection(event: MouseEvent): void {
    event.preventDefault();
  }

  return (
    <div class="composer-rte">
      <div class="composer-toolbar" role="toolbar" aria-label="Text formatting">
        <button
          type="button"
          class="composer-tool"
          classList={{ "is-active": bold() }}
          aria-label="Bold"
          aria-keyshortcuts="Control+B Meta+B"
          aria-pressed={bold()}
          disabled={props.disabled}
          onMouseDown={keepSelection}
          onClick={() =>
            run((s) => (s.hasFormat("B") || s.hasFormat("STRONG") ? s.removeBold() : s.bold()))
          }
        >
          <span aria-hidden="true">B</span>
        </button>
        <button
          type="button"
          class="composer-tool composer-tool-italic"
          classList={{ "is-active": italic() }}
          aria-label="Italic"
          aria-keyshortcuts="Control+I Meta+I"
          aria-pressed={italic()}
          disabled={props.disabled}
          onMouseDown={keepSelection}
          onClick={() =>
            run((s) => (s.hasFormat("I") || s.hasFormat("EM") ? s.removeItalic() : s.italic()))
          }
        >
          <span aria-hidden="true">I</span>
        </button>
        <span class="composer-tool-sep" aria-hidden="true" />
        <button
          type="button"
          class="composer-tool"
          classList={{ "is-active": unordered() }}
          aria-label="Bulleted list"
          aria-pressed={unordered()}
          disabled={props.disabled}
          onMouseDown={keepSelection}
          onClick={() => run((s) => (s.hasFormat("UL") ? s.removeList() : s.makeUnorderedList()))}
        >
          <span aria-hidden="true">•≡</span>
        </button>
        <button
          type="button"
          class="composer-tool"
          classList={{ "is-active": ordered() }}
          aria-label="Numbered list"
          aria-pressed={ordered()}
          disabled={props.disabled}
          onMouseDown={keepSelection}
          onClick={() => run((s) => (s.hasFormat("OL") ? s.removeList() : s.makeOrderedList()))}
        >
          <span aria-hidden="true">1≡</span>
        </button>
        <span class="composer-tool-sep" aria-hidden="true" />
        <button
          type="button"
          class="composer-tool"
          classList={{ "is-active": linkOpen() }}
          aria-label="Insert link"
          aria-expanded={linkOpen()}
          disabled={props.disabled}
          onMouseDown={keepSelection}
          onClick={() => (linkOpen() ? closeLink() : openLink())}
        >
          <span aria-hidden="true">🔗</span>
        </button>
      </div>

      <Show when={linkOpen()}>
        <div class="composer-link-form">
          <input
            ref={linkInput}
            class="composer-link-input"
            type="url"
            inputmode="url"
            placeholder="https://example.com"
            aria-label="Link URL"
            value={linkUrl()}
            onInput={(event) => setLinkUrl(event.currentTarget.value)}
            onKeyDown={onLinkKeyDown}
          />
          <button
            type="button"
            class="composer-link-apply"
            disabled={normalizeUrl(linkUrl()) === null}
            onClick={applyLink}
          >
            Add link
          </button>
          <button type="button" class="composer-link-cancel" onClick={closeLink}>
            Cancel
          </button>
        </div>
      </Show>

      {/* Squire promotes this div to contenteditable on init; contentEditable here makes it focusable
          up front, and role/aria-multiline give it proper multiline-textbox semantics for AT. A
          rich-text surface has to be a contenteditable div, so the "use a native <textarea>"
          suggestion doesn't apply. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a rich-text editor must be a contenteditable div, not a textarea. */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: contentEditable + tabindex make it focusable; the rule doesn't account for contenteditable. */}
      <div
        ref={editorEl}
        class="composer-rte-input"
        contentEditable
        tabindex={0}
        role="textbox"
        aria-multiline="true"
        aria-label={props.ariaLabel}
      />
    </div>
  );
}
