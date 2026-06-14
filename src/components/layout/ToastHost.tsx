import { For } from "solid-js";
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
  // focusout fires when moving between two toasts' buttons too; only resume when focus actually
  // leaves the host (relatedTarget is outside it), else a brief resume would reset the timers.
  function onFocusOut(event: FocusEvent & { currentTarget: HTMLDivElement }) {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) resumeAutoDismiss();
  }

  return (
    <div
      class="toast-host"
      role="status"
      aria-atomic="false"
      onMouseEnter={pauseAutoDismiss}
      onMouseLeave={resumeAutoDismiss}
      onFocusIn={pauseAutoDismiss}
      onFocusOut={onFocusOut}
    >
      <For each={toasts()}>
        {(toast) => (
          <div class="toast">
            <span class="toast-message">{toast.message}</span>
            <button
              type="button"
              class="toast-dismiss"
              aria-label="Dismiss notification"
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
