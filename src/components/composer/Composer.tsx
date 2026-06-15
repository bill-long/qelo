import { createMemo, For, onMount, Show } from "solid-js";
import { RichTextEditor } from "@/components/composer/RichTextEditor";
import { invalidRecipients, parseRecipients } from "@/lib/addresses";
import { formatBytes } from "@/lib/format";
import {
  attachFiles,
  busy,
  composeError,
  discardDraft,
  draft,
  identities,
  removeAttachment,
  saveDraft,
  selectedIdentity,
  selectedIdentityId,
  send,
  setSelectedIdentityId,
  updateDraft,
  uploading,
} from "@/stores/compose";

/** Render an identity as "Name <email>" (or bare email when it has no display name). */
function identityLabel(name: string, email: string): string {
  return name ? `${name} <${email}>` : email;
}

// Platform-aware label for the Cmd/Ctrl+Enter send shortcut. Detected once at module load: the OS
// doesn't change mid-session. `navigator.platform` is deprecated but still the most reliable Mac
// signal in the Tauri webviews; fall back to the user agent.
const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);
/** Short visual hint shown beside Send, e.g. "⌘↵" on macOS, "Ctrl+↵" elsewhere. */
const SEND_SHORTCUT = isMac ? "⌘↵" : "Ctrl+↵";
/** Spelled-out form for the Send button's title/tooltip. */
const SEND_SHORTCUT_TITLE = isMac ? "Send (⌘ Return)" : "Send (Ctrl+Enter)";

/**
 * The compose window (D3: plain-text, new message). A native modal `<dialog>` over the three-pane
 * shell, mounted only while `composeOpen()`. Using the platform dialog (opened with `showModal()`)
 * gives real modal semantics for free — focus is trapped inside, the background is inert to AT, and
 * Escape fires `cancel` — rather than bolting a partial focus-trap onto a plain div. Inputs dispatch
 * through `updateDraft`; Send/Save draft/Discard call the store actions, which own the JMAP round
 * trips and surface errors. Send needs ≥1 valid recipient and a resolved identity; both submits are
 * gated while one is in flight and rejected (in the store) on a mistyped recipient.
 */
export function Composer() {
  let dialog: HTMLDialogElement | undefined;
  let toInput: HTMLInputElement | undefined;
  // showModal() promotes the dialog to the top layer (trap + inert background + ::backdrop); then
  // land focus on the To field rather than the dialog's first focusable (the close button).
  onMount(() => {
    dialog?.showModal();
    toInput?.focus();
  });

  const invalidTo = createMemo(() => invalidRecipients(draft.to));
  const invalidCc = createMemo(() => invalidRecipients(draft.cc));
  const invalidBcc = createMemo(() => invalidRecipients(draft.bcc));
  const hasRecipient = createMemo(() =>
    Boolean(parseRecipients(draft.to) || parseRecipients(draft.cc) || parseRecipients(draft.bcc)),
  );
  const hasInvalid = createMemo(
    () => invalidTo().length > 0 || invalidCc().length > 0 || invalidBcc().length > 0,
  );
  // Both submits need a resolved identity (so they aren't briefly enabled before loadIdentities()
  // resolves) and no invalid tokens (the store rejects those rather than drop them silently), and
  // must wait out any in-flight upload so a blobId can't be dropped from the create. Send
  // additionally needs ≥1 recipient; a draft may be recipient-less, so Save does not.
  const ready = createMemo(
    () => !hasInvalid() && Boolean(selectedIdentity()) && busy() === null && !uploading(),
  );
  const canSend = createMemo(() => ready() && hasRecipient());
  const canSave = createMemo(() => ready());
  // Gates BOTH attach and remove controls: blocked during a submit and during an in-flight upload.
  // A fresh pick is ignored mid-upload, so don't invite one; and removing a chip mid-batch is unsafe
  // because a later same-batch file that dedupes to a removed blobId would re-append it (attachFiles
  // only checks the *current* draft). Discard/✕/Escape are NOT blocked by an upload — the store's
  // draft-generation guard makes a late-resolving upload harmless, so the user is never trapped
  // waiting on a slow upload; those are blocked only during an actual send/save submit.
  const attachLocked = createMemo(() => busy() !== null || uploading());

  // Pull the selected files off the input, hand them to the store to upload, then clear the input's
  // value so re-picking the same file fires another change event.
  function onPickFiles(event: { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";
    if (files.length > 0) void attachFiles(files);
  }

  // The native dialog fires "cancel" on Escape. We own closing — discardDraft resets the store and
  // unmounts the dialog — so preventDefault and discard only when idle, so Escape can't yank the
  // window out from under an in-flight send. (Backdrop clicks are intentionally NOT dismissive: a
  // stray click shouldn't drop a draft — closing is explicit via Discard / the ✕.)
  function onCancel(event: Event) {
    event.preventDefault();
    if (busy() === null) discardDraft();
  }

  // Cmd/Ctrl+Enter sends (when sendable) from anywhere in the dialog — including the body editor,
  // where a bare Enter inserts a newline and the modifier combo is otherwise inert. Escape→discard
  // is handled natively by the dialog's `cancel` event (onCancel above), so it's not duplicated here.
  function onKeyDown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (canSend()) void send();
    }
  }

  return (
    <dialog
      ref={dialog}
      class="composer"
      aria-labelledby="composer-title"
      onCancel={onCancel}
      onKeyDown={onKeyDown}
    >
      <header class="composer-head">
        <h2 id="composer-title" class="composer-title">
          New message
        </h2>
        <button
          type="button"
          class="composer-close"
          aria-label="Discard and close"
          disabled={busy() !== null}
          onClick={() => discardDraft()}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <div class="composer-fields">
        <Show
          when={identities().length > 1}
          fallback={
            <Show when={identities()[0]}>
              {(only) => (
                <div class="composer-field">
                  <span class="composer-label">From</span>
                  <span class="composer-from">{identityLabel(only().name, only().email)}</span>
                </div>
              )}
            </Show>
          }
        >
          <label class="composer-field">
            <span class="composer-label">From</span>
            <select
              class="composer-input"
              value={selectedIdentityId() ?? ""}
              onChange={(event) => setSelectedIdentityId(event.currentTarget.value)}
            >
              <For each={identities()}>
                {(id) => <option value={id.id}>{identityLabel(id.name, id.email)}</option>}
              </For>
            </select>
          </label>
        </Show>

        <label class="composer-field">
          <span class="composer-label">To</span>
          <input
            ref={toInput}
            class="composer-input"
            type="text"
            autocomplete="off"
            aria-invalid={invalidTo().length > 0}
            aria-describedby={invalidTo().length > 0 ? "composer-to-error" : undefined}
            value={draft.to}
            onInput={(event) => updateDraft("to", event.currentTarget.value)}
          />
        </label>
        <Show when={invalidTo().length > 0}>
          <p id="composer-to-error" class="composer-invalid">
            Not a valid address: {invalidTo().join(", ")}
          </p>
        </Show>

        <label class="composer-field">
          <span class="composer-label">Cc</span>
          <input
            class="composer-input"
            type="text"
            autocomplete="off"
            aria-invalid={invalidCc().length > 0}
            aria-describedby={invalidCc().length > 0 ? "composer-cc-error" : undefined}
            value={draft.cc}
            onInput={(event) => updateDraft("cc", event.currentTarget.value)}
          />
        </label>
        <Show when={invalidCc().length > 0}>
          <p id="composer-cc-error" class="composer-invalid">
            Not a valid address: {invalidCc().join(", ")}
          </p>
        </Show>

        <label class="composer-field">
          <span class="composer-label">Bcc</span>
          <input
            class="composer-input"
            type="text"
            autocomplete="off"
            aria-invalid={invalidBcc().length > 0}
            aria-describedby={invalidBcc().length > 0 ? "composer-bcc-error" : undefined}
            value={draft.bcc}
            onInput={(event) => updateDraft("bcc", event.currentTarget.value)}
          />
        </label>
        <Show when={invalidBcc().length > 0}>
          <p id="composer-bcc-error" class="composer-invalid">
            Not a valid address: {invalidBcc().join(", ")}
          </p>
        </Show>

        <label class="composer-field">
          <span class="composer-label">Subject</span>
          <input
            class="composer-input"
            type="text"
            value={draft.subject}
            onInput={(event) => updateDraft("subject", event.currentTarget.value)}
          />
        </label>

        <RichTextEditor
          ariaLabel="Message body"
          html={draft.bodyHtml}
          disabled={busy() !== null}
          onInput={(html) => updateDraft("bodyHtml", html)}
        />

        <div class="composer-attach">
          {/* A real <label> wrapping the input names it for AT; the input is visually hidden and
              the styled span is the visible affordance. Picking is disabled during a submit and
              while an upload is in flight (a fresh pick is ignored mid-upload, so don't invite it). */}
          <label class="composer-attach-label" classList={{ "is-disabled": attachLocked() }}>
            <span aria-hidden="true">📎</span> Attach files
            <input
              type="file"
              class="composer-attach-input"
              multiple
              disabled={attachLocked()}
              onChange={onPickFiles}
            />
          </label>
          <Show when={uploading()}>
            <span class="composer-uploading" role="status">
              Uploading…
            </span>
          </Show>
        </div>

        <Show when={draft.attachments.length > 0}>
          <ul class="composer-attachments">
            <For each={draft.attachments}>
              {(att) => (
                <li class="composer-attachment">
                  <span class="composer-attachment-name">{att.name}</span>
                  <span class="composer-attachment-size">{formatBytes(att.size)}</span>
                  <button
                    type="button"
                    class="composer-attachment-remove"
                    aria-label={`Remove attachment ${att.name}`}
                    disabled={attachLocked()}
                    onClick={() => removeAttachment(att.blobId)}
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <Show when={composeError()}>
        {(message) => (
          <p class="composer-error" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <footer class="composer-actions">
        <button
          type="button"
          class="composer-send"
          title={SEND_SHORTCUT_TITLE}
          // Expose the shortcut to AT reliably (title alone is unreliably surfaced). Both modifiers
          // are listed since the handler accepts either Ctrl or Cmd regardless of platform.
          aria-keyshortcuts="Control+Enter Meta+Enter"
          disabled={!canSend()}
          onClick={() => void send()}
        >
          {busy() === "send" ? "Sending…" : "Send"}
          {/* Decorative shortcut hint — the spelled-out combo is on the button's title for AT. */}
          <Show when={busy() !== "send"}>
            <span class="composer-shortcut" aria-hidden="true">
              {SEND_SHORTCUT}
            </span>
          </Show>
        </button>
        <button
          type="button"
          class="composer-save"
          disabled={!canSave()}
          onClick={() => void saveDraft()}
        >
          {busy() === "save" ? "Saving…" : "Save draft"}
        </button>
        <button
          type="button"
          class="composer-discard"
          disabled={busy() !== null}
          onClick={() => discardDraft()}
        >
          Discard
        </button>
      </footer>
    </dialog>
  );
}
