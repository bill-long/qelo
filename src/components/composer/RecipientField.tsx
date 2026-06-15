import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { splitRecipients } from "@/lib/addresses";
import { activeFragment, completeFragment, type RecipientSuggestion } from "@/lib/recipients";
import { recipientSuggestions } from "@/stores/recipients";

/**
 * A recipient input (To/Cc/Bcc) with past-recipient autocomplete, following the WAI-ARIA APG
 * combobox pattern ("list autocomplete with manual selection"): the text input is the `combobox`,
 * the suggestion dropdown is its `listbox`, and the active option is tracked via
 * `aria-activedescendant` rather than moving focus. Arrow keys move the active option, Enter accepts
 * it, Escape dismisses the popup (without bubbling to the dialog's Escape→discard), and clicking an
 * option selects it. Autocomplete operates on the address FRAGMENT the caret sits in (a recipient
 * field is a separator-joined list), and a pick inserts only the bare email — the field stays exactly
 * what `lib/addresses.ts` parses and the store's send-time validator still vets every token.
 */
export function RecipientField(props: {
  id: string;
  value: string;
  invalid: boolean;
  /** Id of the inline validation message, mirrored onto the input's `aria-describedby`. */
  errorId: string | undefined;
  onInput: (value: string) => void;
  /** Lets the parent grab the underlying input (e.g. to autofocus To on open). */
  inputRef?: (el: HTMLInputElement) => void;
}) {
  let inputEl: HTMLInputElement | undefined;
  const [open, setOpen] = createSignal(false);
  // Index of the highlighted option, or -1 for none (manual selection: nothing is auto-highlighted,
  // so a bare Enter never inserts an address the user didn't arrow to).
  const [active, setActive] = createSignal(-1);
  // The caret offset, tracked so the suggestion memo knows which fragment is being edited.
  const [caret, setCaret] = createSignal(0);

  const listboxId = () => `${props.id}-listbox`;
  const optionId = (i: number) => `${props.id}-option-${i}`;

  // The lowercased emails already entered in OTHER fragments, so a pick isn't re-suggested. Blank out
  // the active fragment first so the half-typed address being completed doesn't exclude itself.
  function enteredElsewhere(): Set<string> {
    const frag = activeFragment(props.value, caret());
    const rest = `${props.value.slice(0, frag.start)} ${props.value.slice(frag.end)}`;
    return new Set(splitRecipients(rest).map((t) => t.toLowerCase()));
  }

  const suggestions = createMemo<RecipientSuggestion[]>(() => {
    if (!open()) return [];
    const frag = activeFragment(props.value, caret());
    if (!frag.text) return [];
    return recipientSuggestions(frag.text, enteredElsewhere());
  });

  // The combobox is only truly "expanded" when there are options to show.
  const expanded = createMemo(() => open() && suggestions().length > 0);

  // Keep the highlight in range as the list changes under it (e.g. the caret moves to a fragment with
  // fewer matches): an `active` past the new end would point aria-activedescendant at a missing option
  // id. Drop the highlight rather than silently aim it off the end.
  createEffect(() => {
    const count = suggestions().length;
    setActive((i) => (i >= count ? -1 : i));
  });

  // Keep the highlighted option visible in the (max-height, scrolling) listbox — APG requires the
  // active option stay in view as the user arrows through it.
  createEffect(() => {
    const i = active();
    if (i >= 0 && expanded()) {
      document.getElementById(optionId(i))?.scrollIntoView({ block: "nearest" });
    }
  });

  function syncCaret(): void {
    if (inputEl) setCaret(inputEl.selectionStart ?? inputEl.value.length);
  }

  function onInput(event: { currentTarget: HTMLInputElement }): void {
    const el = event.currentTarget;
    setCaret(el.selectionStart ?? el.value.length);
    setOpen(true);
    setActive(-1); // typing invalidates any prior highlight
    props.onInput(el.value);
  }

  function close(): void {
    setOpen(false);
    setActive(-1);
  }

  function choose(s: RecipientSuggestion): void {
    const { value, caret: newCaret } = completeFragment(props.value, caret(), s.email);
    props.onInput(value);
    close();
    // The value flows back through the store prop; restore focus + caret after that re-render so the
    // user keeps typing the next address right where the inserted ", " left off.
    queueMicrotask(() => {
      const el = inputEl;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }

  function onKeyDown(event: KeyboardEvent): void {
    const list = suggestions();
    if (event.key === "ArrowDown") {
      // Open on the first ArrowDown; otherwise advance the highlight (wrapping).
      event.preventDefault();
      if (!open()) {
        setOpen(true);
        return;
      }
      if (list.length === 0) return;
      setActive((i) => (i + 1) % list.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (list.length === 0) return;
      setActive((i) => (i <= 0 ? list.length - 1 : i - 1));
    } else if (event.key === "Enter") {
      const chosen = list[active()];
      if (expanded() && chosen) {
        // Accept the highlighted suggestion. Stop the event so it can't also reach the dialog (a
        // bare Enter doesn't send — that's Ctrl/Cmd+Enter — but don't risk a stray default/submit).
        event.preventDefault();
        event.stopPropagation();
        choose(chosen);
      }
    } else if (event.key === "Escape") {
      // Intercept Escape ONLY when the popup is actually visible: dismiss it and DON'T let the
      // keystroke reach the native dialog's cancel→discard (preventDefault suppresses that, as the
      // RichTextEditor link form already relies on). With no popup showing, let Escape fall through so
      // it closes the composer as usual — don't swallow a "dead" keystroke.
      if (expanded()) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }
  }

  return (
    <div class="composer-combobox">
      <input
        ref={(el) => {
          inputEl = el;
          props.inputRef?.(el);
        }}
        id={props.id}
        class="composer-input"
        type="text"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded()}
        // Only reference the listbox while it's actually in the DOM (it's conditionally rendered on
        // expanded()); pointing aria-controls at a missing id when collapsed is invalid.
        aria-controls={expanded() ? listboxId() : undefined}
        aria-activedescendant={active() >= 0 && expanded() ? optionId(active()) : undefined}
        aria-invalid={props.invalid}
        aria-describedby={props.errorId}
        value={props.value}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onBlur={close}
      />
      <Show when={expanded()}>
        {/* The APG combobox popup is a role=listbox of role=option items, on <div>s (a <ul>/<li> is
            "non-interactive" to the linter and can't carry an interactive role). Selection is tracked
            via aria-activedescendant on the input — focus never leaves it — so the options are
            intentionally not individually focusable. */}
        <div
          class="composer-suggestions"
          role="listbox"
          id={listboxId()}
          aria-label="Address suggestions"
        >
          <For each={suggestions()}>
            {(s, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: APG combobox option — selection is tracked with aria-activedescendant on the input, so options are intentionally not tab-focusable.
              <div
                id={optionId(i())}
                class="composer-suggestion"
                classList={{ "is-active": active() === i() }}
                role="option"
                aria-selected={active() === i()}
                // mousedown (not click) + preventDefault keeps focus in the input, so onBlur doesn't
                // close the popup out from under the selection.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(s);
                }}
              >
                <Show
                  when={s.name}
                  fallback={<span class="composer-suggestion-email">{s.email}</span>}
                >
                  <span class="composer-suggestion-name">{s.name}</span>
                  <span class="composer-suggestion-email">{s.email}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
