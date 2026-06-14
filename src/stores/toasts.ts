import { createSignal } from "solid-js";

// Transient confirmation toasts — the brief "Message sent" / "Draft saved" feedback that keeps a
// successful compose action from being a silent disappearance. Errors are NOT routed here; they
// surface inline at their source (composeError, per-row error text). A toast auto-dismisses after a
// few seconds and can be dismissed sooner. The queue is a plain signal of {id, message}; ids are
// monotonic integers (never an external/server string), so there's no map-keyed-by-untrusted-input
// footgun here.

export interface Toast {
  id: number;
  message: string;
}

/** How long a toast stays up before auto-dismissing. */
const DISMISS_MS = 4000;
/** Cap the visible stack so a burst can't pile up; oldest are dropped first. */
const MAX_TOASTS = 3;

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 0;
// Live auto-dismiss timers keyed by toast id, so a toast can be removed early (clearing its timer)
// and so the whole set can be paused/resumed while the user hovers or focuses the stack.
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export { toasts };

function scheduleDismiss(id: number): void {
  // Guard for non-DOM/test environments without a timer; tests drive timing via fake timers.
  if (typeof setTimeout === "undefined") return;
  timers.set(
    id,
    setTimeout(() => dismissToast(id), DISMISS_MS),
  );
}

function clearTimer(id: number): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    clearTimeout(handle);
    timers.delete(id);
  }
}

/**
 * Show a transient confirmation toast and return its id. It auto-dismisses after {@link DISMISS_MS}
 * (unless paused via {@link pauseAutoDismiss}) and the stack is capped at {@link MAX_TOASTS}, with
 * the oldest dropped (and its timer cleared) on overflow. Use for success confirmations only —
 * errors belong inline at their source.
 */
export function notify(message: string): number {
  nextId += 1;
  const id = nextId;
  setToasts((prev) => {
    const next = [...prev, { id, message }];
    // Enforce the cap, cancelling the timer for any toast we drop so it doesn't fire later.
    while (next.length > MAX_TOASTS) {
      const dropped = next.shift();
      if (dropped) clearTimer(dropped.id);
    }
    return next;
  });
  scheduleDismiss(id);
  return id;
}

/** Remove a toast by id (the dismiss control, and the auto-dismiss timer). */
export function dismissToast(id: number): void {
  clearTimer(id);
  setToasts((prev) => prev.filter((t) => t.id !== id));
}

/**
 * Pause every toast's auto-dismiss — called while the user hovers or focuses the stack, so a toast
 * they're reading (or whose dismiss button they've tabbed to) doesn't vanish out from under them.
 * {@link resumeAutoDismiss} restarts the countdown when they leave.
 */
export function pauseAutoDismiss(): void {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
}

/** Restart the auto-dismiss countdown for any toast without a live timer (after a pause). */
export function resumeAutoDismiss(): void {
  for (const toast of toasts()) {
    if (!timers.has(toast.id)) scheduleDismiss(toast.id);
  }
}

/** Clear all toasts (and their timers) — a test seam; app flow lets them expire or be dismissed. */
export function clearToasts(): void {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
  setToasts([]);
}
