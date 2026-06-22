import { For, Show } from "solid-js";
import { dismissToast, pauseAutoDismiss, resumeAutoDismiss, toasts } from "@/stores/toasts";

/**
 * Renders the transient confirmation toasts (e.g. "Message sent"). The container is a polite live
 * region (`role="status"`, which already implies `aria-live="polite"`) that exists in the DOM at all
 * times, so a screen reader announces each toast as it's appended without stealing focus.
 * `aria-atomic="false"` overrides the role's default so only the newly added toast is announced, not
 * the whole stack re-read on every change. The host is click-through (pointer-events:none in CSS);
 * each toast re-enables pointer events for its dismiss control.
 *
 * Hovering or focusing the stack pauses auto-dismiss (resumed on leave) so a toast being read — or
 * whose dismiss button has been tabbed to — doesn't disappear mid-interaction and strand focus.
 */
export function ToastHost() {
  // Resume only when the pointer/focus actually LEAVES the host: mouseout (and focusout) also fire
  // when moving between two toasts, where relatedTarget is still inside the host — a spurious resume
  // there would reset the timers mid-interaction. Mirrors the relatedTarget check for both events.
  function onLeave(event: { relatedTarget: EventTarget | null; currentTarget: HTMLDivElement }) {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) resumeAutoDismiss();
  }

  return (
    // The host is pointer-events:none (click-through); the toasts re-enable it. So hover must use
    // BUBBLING mouseover/mouseout (which propagate up from the toasts) — onMouseEnter/Leave bind to
    // the host itself, which never receives pointer events and so would never pause on hover. The
    // keyboard equivalent IS handled (onFocusIn/onFocusOut, which bubble from the toast buttons),
    // but the lint rule only recognises the non-bubbling onFocus/onBlur — which wouldn't fire for
    // descendants here — so the mouse/keyboard parity it checks for is satisfied differently.
    // biome-ignore lint/a11y/useKeyWithMouseEvents: focus parity is via bubbling onFocusIn/onFocusOut (onFocus doesn't bubble to this container in Solid).
    <div
      class="toast-host"
      role="status"
      aria-atomic="false"
      onMouseOver={pauseAutoDismiss}
      onMouseOut={onLeave}
      onFocusIn={pauseAutoDismiss}
      onFocusOut={onLeave}
    >
      <For each={toasts()}>
        {(toast) => (
          <div class="toast">
            <span class="toast-message">{toast.message}</span>
            <Show when={toast.action}>
              {(action) => (
                <button
                  type="button"
                  class="toast-action"
                  // Restate the toast's context in the accessible name: the visible text is just the
                  // verb ("Undo"), but with up to 3 stacked toasts a screen-reader/keyboard user
                  // tabbing the buttons needs to know WHICH move each reverses ("Undo: Moved to Spam"
                  // vs "Undo: Moved to Archive"). Also surfaces the action behind the polite status
                  // region, which announces the message text but not reliably the button.
                  aria-label={`${action().label}: ${toast.message}`}
                  onClick={() => {
                    // Run the action (may be async — fire-and-forget; the store action self-heals
                    // and never rejects), then dismiss — clicking "Undo" shouldn't leave the toast up.
                    void action().run();
                    dismissToast(toast.id);
                  }}
                >
                  {action().label}
                </button>
              )}
            </Show>
            <button
              type="button"
              class="toast-dismiss"
              // Restate the toast so stacked toasts' dismiss buttons aren't all "Dismiss notification"
              // (parity with the action button's contextual label).
              aria-label={`Dismiss: ${toast.message}`}
              onClick={() => dismissToast(toast.id)}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
