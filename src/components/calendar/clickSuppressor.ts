import { onCleanup } from "solid-js";

/**
 * Click-suppression for a pointer-drag engine (shared by the week/day {@link WeekGrid} and month
 * {@link MonthGrid} drag surfaces). After a committed drag, the trailing native `click` must be
 * swallowed so a move/resize/create doesn't ALSO select the underlying element. The lifecycle is subtle
 * enough that both engines must share ONE implementation — a fix to it can't be made in only one place.
 *
 * Returns three functions:
 *  - `reset()` — call at the TOP of every pointerdown (before any early return), so a prior drag that
 *    ended WITHOUT a trailing click (the pointer released off any target) can't leave the flag set and
 *    swallow the next click. (pointerdown always precedes the click, so clearing here is safe.)
 *  - `arm()` — call the instant a gesture commits. Sets the flag AND auto-clears it on the next
 *    macrotask: the synchronous trailing `click` (right after pointerup) still sees it set and is
 *    swallowed, but if NO trailing click fires the flag can't linger and swallow a later KEYBOARD
 *    activation (Enter/Space → click, which never runs through pointerdown to reset it).
 *  - `consume()` — call in the target's onClick handler; returns whether to swallow this click (and
 *    resets the flag either way).
 *
 * The macrotask timer is cleared on unmount via `onCleanup`, so this MUST be created in a component
 * (reactive owner) scope.
 */
export function createClickSuppressor(): {
  reset: () => void;
  arm: () => void;
  consume: () => boolean;
} {
  let suppress = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return {
    reset() {
      suppress = false;
    },
    arm() {
      suppress = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        suppress = false;
      }, 0);
    },
    consume() {
      const s = suppress;
      suppress = false;
      return s;
    },
  };
}
