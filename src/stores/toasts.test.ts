import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearToasts,
  dismissToast,
  notify,
  pauseAutoDismiss,
  resumeAutoDismiss,
  toasts,
} from "./toasts";

// The auto-dismiss window; advancing at least this far guarantees a live timer fires.
const DISMISS_AT_LEAST = 4000;

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends a toast with a unique monotonic id and the given message", () => {
    const a = notify("Message sent");
    const b = notify("Draft saved");
    expect(b).toBeGreaterThan(a);
    expect(toasts()).toEqual([
      { id: a, message: "Message sent" },
      { id: b, message: "Draft saved" },
    ]);
  });

  it("auto-dismisses after the timeout", () => {
    notify("Message sent");
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(3999);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);
  });

  it("dismisses a single toast by id without touching the others", () => {
    const a = notify("first");
    const b = notify("second");
    dismissToast(a);
    expect(toasts()).toEqual([{ id: b, message: "second" }]);
  });

  it("cancels the auto-dismiss timer on manual dismiss so it can't fire later", () => {
    const a = notify("first");
    dismissToast(a);
    expect(toasts()).toHaveLength(0);
    // The id is reused only by accident; add another toast, advance past `a`'s original deadline,
    // and confirm `a`'s cancelled timer doesn't disturb it.
    notify("later");
    vi.advanceTimersByTime(3999);
    expect(toasts()).toEqual([expect.objectContaining({ message: "later" })]);
  });

  it("caps the visible stack at three, dropping the oldest first", () => {
    notify("one");
    notify("two");
    const three = notify("three");
    const four = notify("four");
    expect(toasts().map((t) => t.message)).toEqual(["two", "three", "four"]);
    expect(toasts().map((t) => t.id)).toEqual([three - 1, three, four]);
  });

  it("does not fire a dropped (capped-out) toast's timer", () => {
    const one = notify("one");
    notify("two");
    notify("three");
    notify("four"); // pushes "one" out
    // "one"'s timer was cleared on eviction; advancing past it must not remove a current toast.
    vi.advanceTimersByTime(DISMISS_AT_LEAST);
    expect(toasts().map((t) => t.id)).not.toContain(one);
    expect(toasts()).toHaveLength(0); // all four timers eventually fire, none double-removes
  });

  it("pauses auto-dismiss and resumes the countdown afresh", () => {
    notify("hovered");
    vi.advanceTimersByTime(2000);
    pauseAutoDismiss();
    // While paused, time passing must not dismiss it.
    vi.advanceTimersByTime(10000);
    expect(toasts()).toHaveLength(1);
    // Resuming restarts a full countdown.
    resumeAutoDismiss();
    vi.advanceTimersByTime(3999);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);
  });
});
