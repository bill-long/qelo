import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { WeekGrid } from "@/components/calendar/WeekGrid";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import { LOCAL_ZONE } from "@/lib/calendar";
import {
  rescheduleEvent,
  resetCalendar,
  setCalendarEvents,
  setCalendarReady,
  setCalendars,
  setEventIds,
} from "@/stores/calendar";
import {
  createSeed,
  creatingEvent,
  selectedEventId,
  setCalendarAnchor,
  setCalendarDisplayZone,
  setCalendarViewMode,
  setCreateSeed,
  setCreatingEvent,
  setSelectedCalendarId,
  setSelectedEventId,
} from "@/stores/ui";

// Mock only the reschedule write (it resolves the base via the network); everything else is real.
vi.mock("@/stores/calendar", async (importActual) => {
  const actual = await importActual<typeof import("@/stores/calendar")>();
  return { ...actual, rescheduleEvent: vi.fn(async () => ({ ok: true })) };
});
const rescheduleMock = rescheduleEvent as unknown as Mock;

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return { "@type": "Event", id: "e", calendarIds: { c1: true }, ...partial };
}

// A writable calendar so eventMayWrite lets a drag start.
function writableCal(): Calendar {
  return {
    id: "c1",
    name: "Cal",
    description: null,
    color: null,
    timeZone: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: true,
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: true,
      mayWriteOwn: true,
      mayUpdatePrivate: true,
      mayRSVP: true,
      mayShare: true,
      mayDelete: true,
    },
  };
}

function seed(events: Record<string, CalendarEvent>, ids: string[]) {
  setCalendarReady(true);
  setCalendars(reconcile({ c1: writableCal() }));
  setCalendarEvents(reconcile(events));
  setEventIds(ids);
}

// The cols container is 700px wide (7 cols × 100px) and 1440px tall, so clientY === minutes-from-
// midnight and clientX maps directly to a day column — making a pointer drop a concrete grid position.
// jsdom returns a zero rect otherwise. setPointerCapture is unimplemented in jsdom → stub it.
let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  // Fake only Date so the now-indicator's day is deterministic; SolidJS timers stay real (the
  // WeekGrid's once-a-minute setInterval never needs to fire in these tests).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 5, 17, 9, 30)); // Wed Jun 17 2026, 09:30 local
  rescheduleMock.mockClear();
  rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 700,
    height: 1440,
    right: 700,
    bottom: 1440,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  // jsdom doesn't implement pointer capture — stub it so the drag handlers don't throw. Deleted in
  // afterEach (jsdom defines neither on the prototype, so delete restores the pristine absence) to keep
  // the global prototype mutation from leaking into other test files.
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
  setCreatingEvent(false);
  setCreateSeed(null);
  setCalendarDisplayZone(LOCAL_ZONE);
  setCalendarViewMode("week");
  setCalendarAnchor(new Date(2026, 5, 17)); // week Sun Jun 14 … Sat Jun 20
});
afterEach(() => {
  cleanup();
  rectSpy?.mockRestore();
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
  setCreatingEvent(false);
  setCreateSeed(null);
  setCalendarDisplayZone(LOCAL_ZONE);
  vi.useRealTimers();
});

describe("WeekGrid", () => {
  it("renders a timed event as a clickable block and selects it", () => {
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) }, [
      "s",
    ]);
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Standup/ });
    expect(block).toBeTruthy();
    fireEvent.click(block);
    expect(selectedEventId()).toBe("s");
  });

  it("renders an all-day event in the all-day lane, not the time grid", () => {
    seed(
      {
        a: ev({
          id: "a",
          title: "Holiday",
          start: "2026-06-16T00:00:00",
          duration: "P1D",
          showWithoutTime: true,
        }),
      },
      ["a"],
    );
    const { container } = render(() => <WeekGrid columns={7} />);
    expect(screen.getByRole("button", { name: /Holiday/ })).toBeTruthy();
    // The bar lives in the all-day lane (a span), not as a positioned time-grid block.
    expect(container.querySelector(".week-allday-bar")).toBeTruthy();
    expect(container.querySelector(".week-event")).toBeNull();
  });

  it("shows the now-indicator only on today's column", () => {
    seed({}, []);
    const { container } = render(() => <WeekGrid columns={7} />);
    // Today (Jun 17) is in the visible week → exactly one now-line, on that single column.
    expect(container.querySelectorAll(".week-now").length).toBe(1);
  });

  it("omits the now-indicator when today isn't in view", () => {
    setCalendarAnchor(new Date(2026, 6, 17)); // a July week — today (Jun 17) is off-screen
    seed({}, []);
    const { container } = render(() => <WeekGrid columns={7} />);
    expect(container.querySelectorAll(".week-now").length).toBe(0);
  });

  it("clears its minute timer on unmount (no leaked interval)", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    seed({}, []);
    const result = render(() => <WeekGrid columns={1} />);
    result.unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  // Wed Jun 17 is column index 3 (Sun-start week) → clientX 350 lands in it (100px columns). clientY is
  // minutes-from-midnight (1440px-tall cols). A floating event at 09:00 renders at top 540.
  const WED_X = 350;

  it("drags a timed block to a new time and reschedules it (non-recurring → 'all')", () => {
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) }, [
      "s",
    ]);
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Standup/ });
    fireEvent.pointerDown(block, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(block, { clientX: WED_X, clientY: 660, pointerId: 1 }); // → 11:00
    fireEvent.pointerUp(block, { clientX: WED_X, clientY: 660, pointerId: 1 });

    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [occId, newStart, durMs, mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
    expect(occId).toBe("s");
    expect(newStart).toMatchObject({ year: 2026, month: 6, day: 17, hour: 11, minute: 0 });
    expect(durMs).toBeNull();
    expect(mode).toBe("all");
    expect(recurrenceId).toBeNull();
    // A committed drag must NOT also select the event (the trailing click is swallowed).
    expect(selectedEventId()).toBeNull();
  });

  it("treats a press that doesn't pass the threshold as a click (selects, no reschedule)", () => {
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) }, [
      "s",
    ]);
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Standup/ });
    fireEvent.pointerDown(block, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(block, { clientX: WED_X + 2, clientY: 542, pointerId: 1 }); // < threshold
    fireEvent.pointerUp(block, { clientX: WED_X + 2, clientY: 542, pointerId: 1 });
    fireEvent.click(block);
    expect(rescheduleMock).not.toHaveBeenCalled();
    expect(selectedEventId()).toBe("s");
  });

  it("does not start a drag on a read-only calendar's event", () => {
    setCalendarReady(true);
    setCalendars(
      reconcile({
        c1: {
          ...writableCal(),
          myRights: { ...writableCal().myRights, mayWriteAll: false, mayWriteOwn: false },
        },
      }),
    );
    setCalendarEvents(
      reconcile({
        s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }),
      }),
    );
    setEventIds(["s"]);
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Standup/ });
    fireEvent.pointerDown(block, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    expect(rescheduleMock).not.toHaveBeenCalled();
  });

  it("won't start a drag from a midnight-crossing event's LATER block (start block only)", () => {
    // 23:00 Tue Jun 16 → 01:00 Wed Jun 17: renders a clipped block in the Jun 16 column AND the Jun 17
    // column. Grabbing the LATER (Jun 17, index 3 → x=350) block must NOT drag — its position maps to a
    // different instant than the event's start, so it stays a click. (Grabbing the start block does drag.)
    seed(
      { x: ev({ id: "x", title: "Overnight", start: "2026-06-16T23:00:00", duration: "PT2H" }) },
      ["x"],
    );
    render(() => <WeekGrid columns={7} />);
    const blocks = screen.getAllByRole("button", { name: /Overnight/ });
    expect(blocks.length).toBe(2); // one piece per covered day
    const laterBlock = blocks[1] as HTMLElement; // the Jun 17 (00:00–01:00) piece
    fireEvent.pointerDown(laterBlock, { clientX: 350, clientY: 30, pointerId: 1, button: 0 });
    fireEvent.pointerMove(laterBlock, { clientX: 350, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(laterBlock, { clientX: 350, clientY: 200, pointerId: 1 });
    expect(rescheduleMock).not.toHaveBeenCalled();
    // It still selects on the trailing click.
    fireEvent.click(laterBlock);
    expect(selectedEventId()).toBe("x");
  });

  it("prompts for scope on a recurring drag and reschedules with the chosen mode", () => {
    seed(
      {
        r: ev({
          id: "r",
          title: "Daily sync",
          start: "2026-06-17T09:00:00",
          duration: "PT1H",
          recurrenceId: "2026-06-17T09:00:00",
          recurrenceRule: { "@type": "RecurrenceRule", frequency: "daily" },
        }),
      },
      ["r"],
    );
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Daily sync/ });
    fireEvent.pointerDown(block, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(block, { clientX: WED_X, clientY: 660, pointerId: 1 });

    // The write waits for the scope choice.
    expect(rescheduleMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "This and following events" }));

    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [occId, , , mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
    expect(occId).toBe("r");
    expect(mode).toBe("following");
    expect(recurrenceId).toBe("2026-06-17T09:00:00");
  });

  it("ignores a double-click on a scope button (one reschedule, not two concurrent)", () => {
    seed(
      {
        r: ev({
          id: "r",
          title: "Daily sync",
          start: "2026-06-17T09:00:00",
          duration: "PT1H",
          recurrenceId: "2026-06-17T09:00:00",
          recurrenceRule: { "@type": "RecurrenceRule", frequency: "daily" },
        }),
      },
      ["r"],
    );
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Daily sync/ });
    fireEvent.pointerDown(block, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    const allBtn = screen.getByRole("button", { name: "All events" });
    // Two rapid clicks while the (mocked, async) reschedule is in flight → only the first dispatches.
    fireEvent.click(allBtn);
    fireEvent.click(allBtn);
    expect(rescheduleMock).toHaveBeenCalledTimes(1);
  });

  it("shows top + bottom resize handles only on a writable single-day block", () => {
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) }, [
      "s",
    ]);
    const { container } = render(() => <WeekGrid columns={7} />);
    expect(container.querySelectorAll(".week-event-handle").length).toBe(2);
  });

  it("shows no resize handles on a multi-day (midnight-crossing) block", () => {
    // 23:00 Jun 16 → 01:00 Jun 17: its start block's bottom is clipped at midnight, so resizing the
    // clipped edge would mis-set the duration — no handles (the edit form changes a multi-day length).
    seed(
      { x: ev({ id: "x", title: "Overnight", start: "2026-06-16T23:00:00", duration: "PT2H" }) },
      ["x"],
    );
    const { container } = render(() => <WeekGrid columns={7} />);
    expect(container.querySelectorAll(".week-event-handle").length).toBe(0);
  });

  it("shows no resize handles on a read-only calendar's event", () => {
    setCalendarReady(true);
    setCalendars(
      reconcile({
        c1: {
          ...writableCal(),
          myRights: { ...writableCal().myRights, mayWriteAll: false, mayWriteOwn: false },
        },
      }),
    );
    setCalendarEvents(
      reconcile({
        s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }),
      }),
    );
    setEventIds(["s"]);
    const { container } = render(() => <WeekGrid columns={7} />);
    expect(container.querySelectorAll(".week-event-handle").length).toBe(0);
  });

  it("resizes a block's bottom edge to change its duration (start fixed; non-recurring → 'all')", () => {
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) }, [
      "s",
    ]);
    const { container } = render(() => <WeekGrid columns={7} />);
    const bottom = container.querySelector(".week-event-handle-bottom") as HTMLElement;
    expect(bottom).toBeTruthy();
    // Grab the bottom edge (10:00 = y 600) and drag it down to 12:00 (y 720).
    fireEvent.pointerDown(bottom, { clientX: WED_X, clientY: 600, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bottom, { clientX: WED_X, clientY: 720, pointerId: 1 });
    fireEvent.pointerUp(bottom, { clientX: WED_X, clientY: 720, pointerId: 1 });

    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [occId, newStart, durMs, mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
    expect(occId).toBe("s");
    expect(newStart).toMatchObject({ year: 2026, month: 6, day: 17, hour: 9, minute: 0 }); // unchanged
    expect(durMs).toBe(180 * 60_000); // 09:00 → 12:00 = 3h
    expect(mode).toBe("all");
    expect(recurrenceId).toBeNull();
    // A committed resize must NOT also select (the trailing click is swallowed).
    expect(selectedEventId()).toBeNull();
  });

  it("resizes a block's top edge to change its start and duration (bottom fixed)", () => {
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) }, [
      "s",
    ]);
    const { container } = render(() => <WeekGrid columns={7} />);
    const top = container.querySelector(".week-event-handle-top") as HTMLElement;
    // Grab the top edge (09:00 = y 540) and drag it up to 08:00 (y 480); the bottom stays at 10:00.
    fireEvent.pointerDown(top, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(top, { clientX: WED_X, clientY: 480, pointerId: 1 });
    fireEvent.pointerUp(top, { clientX: WED_X, clientY: 480, pointerId: 1 });

    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [, newStart, durMs, mode] = rescheduleMock.mock.calls[0] ?? [];
    expect(newStart).toMatchObject({ year: 2026, month: 6, day: 17, hour: 8, minute: 0 });
    expect(durMs).toBe(120 * 60_000); // 08:00 → 10:00 = 2h
    expect(mode).toBe("all");
  });

  it("treats a resize that snaps back to the original geometry as a no-op (selects, no reschedule)", () => {
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) }, [
      "s",
    ]);
    const { container } = render(() => <WeekGrid columns={7} />);
    const bottom = container.querySelector(".week-event-handle-bottom") as HTMLElement;
    // Move past the 4px threshold but within a snap step, so the bottom snaps back to 600 (10:00) — an
    // unchanged duration → no write, and the trailing click still selects.
    fireEvent.pointerDown(bottom, { clientX: WED_X, clientY: 600, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bottom, { clientX: WED_X, clientY: 606, pointerId: 1 });
    fireEvent.pointerUp(bottom, { clientX: WED_X, clientY: 606, pointerId: 1 });
    fireEvent.click(bottom);
    expect(rescheduleMock).not.toHaveBeenCalled();
    expect(selectedEventId()).toBe("s");
  });

  it("keeps the fixed (untouched) edge EXACT on a resize-top of a sub-minute event (no rounding drift)", () => {
    // End carries seconds (10:00:30 → fractional bottom). Dragging the TOP to 08:00 must leave the bottom
    // exactly at 10:00:30 — the duration is the source-instant span (08:00:00 → 10:00:30 = 2h30s), NOT a
    // minute-rounded ghost height that would shift the fixed bottom by ~30s.
    seed(
      { s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H30S" }) },
      ["s"],
    );
    const { container } = render(() => <WeekGrid columns={7} />);
    const top = container.querySelector(".week-event-handle-top") as HTMLElement;
    fireEvent.pointerDown(top, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(top, { clientX: WED_X, clientY: 480, pointerId: 1 }); // → 08:00
    fireEvent.pointerUp(top, { clientX: WED_X, clientY: 480, pointerId: 1 });

    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [, newStart, durMs] = rescheduleMock.mock.calls[0] ?? [];
    expect(newStart).toMatchObject({ year: 2026, month: 6, day: 17, hour: 8, minute: 0 });
    expect(durMs).toBe(2 * 60 * 60_000 + 30 * 1_000); // 08:00:00 → 10:00:30, the 30s preserved exactly
  });

  it("treats a sub-minute event resized back to its own grid minute as a no-op (minute-granular, like move)", () => {
    // An event with seconds places at a fractional minute (top 540.5, height 60). Resizing the bottom and
    // releasing it so the duration snaps back to 60 min must NOT write (matching the move path's
    // seconds-tolerant sameWhen) — the trailing click still selects.
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:30", duration: "PT1H" }) }, [
      "s",
    ]);
    const { container } = render(() => <WeekGrid columns={7} />);
    const bottom = container.querySelector(".week-event-handle-bottom") as HTMLElement;
    fireEvent.pointerDown(bottom, { clientX: WED_X, clientY: 600, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bottom, { clientX: WED_X, clientY: 605, pointerId: 1 }); // snaps to 600 → 60min
    fireEvent.pointerUp(bottom, { clientX: WED_X, clientY: 605, pointerId: 1 });
    fireEvent.click(bottom);
    expect(rescheduleMock).not.toHaveBeenCalled();
    expect(selectedEventId()).toBe("s");
  });

  it("prompts for scope on a recurring resize (worded 'Resize') and reschedules with the chosen mode", () => {
    seed(
      {
        r: ev({
          id: "r",
          title: "Daily sync",
          start: "2026-06-17T09:00:00",
          duration: "PT1H",
          recurrenceId: "2026-06-17T09:00:00",
          recurrenceRule: { "@type": "RecurrenceRule", frequency: "daily" },
        }),
      },
      ["r"],
    );
    const { container } = render(() => <WeekGrid columns={7} />);
    const bottom = container.querySelector(".week-event-handle-bottom") as HTMLElement;
    fireEvent.pointerDown(bottom, { clientX: WED_X, clientY: 600, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bottom, { clientX: WED_X, clientY: 720, pointerId: 1 });
    fireEvent.pointerUp(bottom, { clientX: WED_X, clientY: 720, pointerId: 1 });

    expect(rescheduleMock).not.toHaveBeenCalled(); // waits for the scope choice
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Resize"); // the heading reflects the gesture, not "Move"
    fireEvent.click(screen.getByRole("button", { name: "This event" }));

    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [occId, , durMs, mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
    expect(occId).toBe("r");
    expect(durMs).toBe(180 * 60_000);
    expect(mode).toBe("this");
    expect(recurrenceId).toBe("2026-06-17T09:00:00");
  });

  it("still prompts for scope on a recurring drag with NO recurrenceId (never silently moves the whole series)", () => {
    seed(
      {
        r: ev({
          id: "r",
          title: "Daily sync",
          start: "2026-06-17T09:00:00",
          duration: "PT1H",
          // recurring (has a rule) but no recurrenceId — must NOT bypass the chooser.
          recurrenceRule: { "@type": "RecurrenceRule", frequency: "daily" },
        }),
      },
      ["r"],
    );
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Daily sync/ });
    fireEvent.pointerDown(block, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(block, { clientX: WED_X, clientY: 660, pointerId: 1 });

    expect(rescheduleMock).not.toHaveBeenCalled(); // waits for the choice, not auto-"all"
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Per-occurrence modes are aria-disabled without a recurrenceId and clicking them is a no-op (they
    // must NOT silently degrade to a whole-series move).
    const thisBtn = screen.getByRole("button", { name: "This event" });
    expect(thisBtn.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(thisBtn);
    expect(rescheduleMock).not.toHaveBeenCalled();
    // Only "All events" fires.
    fireEvent.click(screen.getByRole("button", { name: "All events" }));
    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [, , , mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
    expect(mode).toBe("all");
    expect(recurrenceId).toBeNull();
  });

  it("sweeps the empty canvas to create a timed event, seeding the create form with the range", () => {
    seed({}, []);
    const { container } = render(() => <WeekGrid columns={7} />);
    const canvas = container.querySelector(".week-cols") as HTMLElement;
    // Sweep 09:00 (y 540) → 11:00 (y 660) on Wed Jun 17 (x 350 = column 3).
    fireEvent.pointerDown(canvas, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });

    expect(creatingEvent()).toBe(true);
    // The new event is anchored to the display zone (default browser-local here); the swept display
    // wall-clock is its start/end verbatim (no title yet).
    expect(createSeed()).toMatchObject({
      allDay: false,
      timeZone: LOCAL_ZONE,
      title: "",
      start: "2026-06-17T09:00",
      end: "2026-06-17T11:00",
    });
  });

  it("shows a 'New event' ghost preview while sweeping (before release)", () => {
    seed({}, []);
    const { container } = render(() => <WeekGrid columns={7} />);
    const canvas = container.querySelector(".week-cols") as HTMLElement;
    fireEvent.pointerDown(canvas, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    // Before release, a live ghost previews the swept range.
    expect(container.querySelector(".week-event-ghost")).toBeNull(); // not until it moves
    fireEvent.pointerMove(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    const ghost = container.querySelector(".week-event-ghost");
    expect(ghost).toBeTruthy();
    expect(ghost?.textContent).toContain("New event");
    fireEvent.pointerUp(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    // The ghost is gone once the gesture ends.
    expect(container.querySelector(".week-event-ghost")).toBeNull();
    // Creating must not also select an event, and no reschedule happens.
    expect(selectedEventId()).toBeNull();
    expect(rescheduleMock).not.toHaveBeenCalled();
  });

  it("anchors the swept event to the active display zone (not floating, swept wall-clock kept)", () => {
    // Viewing in a non-local display zone, a sweep seeds timeZone = that zone with the swept wall-clock
    // verbatim — proving the seed reads the display-zone signal (wired through endCreate), and that the
    // grid position is NOT converted away from where it was drawn.
    setCalendarDisplayZone("America/New_York");
    seed({}, []);
    const { container } = render(() => <WeekGrid columns={7} />);
    const canvas = container.querySelector(".week-cols") as HTMLElement;
    fireEvent.pointerDown(canvas, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    expect(createSeed()).toMatchObject({
      timeZone: "America/New_York",
      start: "2026-06-17T09:00",
      end: "2026-06-17T11:00",
    });
  });

  it("sweeps UPWARD (release above the press) and still seeds start < end", () => {
    seed({}, []);
    const { container } = render(() => <WeekGrid columns={7} />);
    const canvas = container.querySelector(".week-cols") as HTMLElement;
    // Press at 11:00 (y 660), drag UP to 09:00 (y 540): the seed normalizes to 09:00–11:00.
    fireEvent.pointerDown(canvas, { clientX: WED_X, clientY: 660, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: WED_X, clientY: 540, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: WED_X, clientY: 540, pointerId: 1 });
    expect(createSeed()).toMatchObject({ start: "2026-06-17T09:00", end: "2026-06-17T11:00" });
  });

  it("treats a tap on the empty canvas as a default-length new-event slot", () => {
    seed({}, []);
    const { container } = render(() => <WeekGrid columns={7} />);
    const canvas = container.querySelector(".week-cols") as HTMLElement;
    // A press with no movement (a tap) at 09:00 → a default 60-min slot at that time.
    fireEvent.pointerDown(canvas, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: WED_X, clientY: 540, pointerId: 1 });
    expect(creatingEvent()).toBe(true);
    expect(createSeed()).toMatchObject({ start: "2026-06-17T09:00", end: "2026-06-17T10:00" });
  });

  it("does NOT start a create when a block is pressed (the seam: a block press moves, not creates)", () => {
    seed({ s: ev({ id: "s", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) }, [
      "s",
    ]);
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Standup/ });
    // A drag that STARTS on the block must move the block (stopPropagation keeps it off the canvas's
    // create handler) — no create form, no seed.
    fireEvent.pointerDown(block, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    expect(creatingEvent()).toBe(false);
    expect(createSeed()).toBeNull();
  });

  it("a press on a READ-ONLY event's block doesn't create, even with a writable calendar present (stopPropagation seam)", () => {
    // The account HAS a writable calendar (canCreate is true), but the pressed block belongs to a
    // read-only calendar — so startDrag bails WITHOUT setting `drag`. Only the block's stopPropagation
    // keeps the press off the canvas's create handler; without it, startCreate would sweep a create under
    // the read-only block. (The drag()-guard can't catch this case, so this genuinely exercises the seam.)
    const readonly: Calendar = {
      ...writableCal(),
      id: "ro",
      isDefault: false,
      myRights: { ...writableCal().myRights, mayWriteAll: false, mayWriteOwn: false },
    };
    setCalendarReady(true);
    setCalendars(reconcile({ c1: writableCal(), ro: readonly }));
    setCalendarEvents(
      reconcile({
        s: ev({
          id: "s",
          calendarIds: { ro: true },
          title: "Locked",
          start: "2026-06-17T09:00:00",
          duration: "PT1H",
        }),
      }),
    );
    setEventIds(["s"]);
    render(() => <WeekGrid columns={7} />);
    const block = screen.getByRole("button", { name: /Locked/ });
    fireEvent.pointerDown(block, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(block, { clientX: WED_X, clientY: 660, pointerId: 1 });
    expect(creatingEvent()).toBe(false);
    expect(createSeed()).toBeNull();
    expect(rescheduleMock).not.toHaveBeenCalled();
  });

  it("does not start a create on a read-only calendar (nothing writable to create into)", () => {
    setCalendarReady(true);
    setCalendars(
      reconcile({
        c1: {
          ...writableCal(),
          myRights: { ...writableCal().myRights, mayWriteAll: false, mayWriteOwn: false },
        },
      }),
    );
    setEventIds([]);
    const { container } = render(() => <WeekGrid columns={7} />);
    const canvas = container.querySelector(".week-cols") as HTMLElement;
    fireEvent.pointerDown(canvas, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    expect(creatingEvent()).toBe(false);
    expect(createSeed()).toBeNull();
  });

  it("Escape cancels an in-progress create sweep (no form opens)", () => {
    seed({}, []);
    const { container } = render(() => <WeekGrid columns={7} />);
    const canvas = container.querySelector(".week-cols") as HTMLElement;
    fireEvent.pointerDown(canvas, { clientX: WED_X, clientY: 540, pointerId: 1, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(canvas, { clientX: WED_X, clientY: 660, pointerId: 1 });
    expect(creatingEvent()).toBe(false);
    expect(createSeed()).toBeNull();
  });

  // --- Drag-to-move an all-day bar across the lane (the third engine) ---------
  // The visible week is Sun Jun 14 … Sat Jun 20, 7 columns × 100px: col 2 = Jun 16 (x 200–299),
  // col 4 = Jun 18 (x 400–499). An all-day bar is moved by dragging horizontally across columns.
  function allDayEvent(partial: Partial<CalendarEvent> = {}): CalendarEvent {
    return ev({
      id: "h",
      title: "Holiday",
      start: "2026-06-16T00:00:00",
      duration: "P1D",
      showWithoutTime: true,
      ...partial,
    });
  }

  it("drags an all-day bar to another day and reschedules it (non-recurring → 'all')", () => {
    seed({ h: allDayEvent() }, ["h"]);
    render(() => <WeekGrid columns={7} />);
    const bar = screen.getByRole("button", { name: /Holiday/ });
    fireEvent.pointerDown(bar, { clientX: 250, clientY: 10, pointerId: 1, button: 0 }); // col 2 (Jun 16)
    fireEvent.pointerMove(bar, { clientX: 450, clientY: 10, pointerId: 1 }); // col 4 (Jun 18) → +2 days
    fireEvent.pointerUp(bar, { clientX: 450, clientY: 10, pointerId: 1 });

    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [occId, newStart, durMs, mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
    expect(occId).toBe("h");
    // Pure civil-day shift of the SOURCE date (+2), keeping T00:00:00 — no zone inversion.
    expect(newStart).toMatchObject({ year: 2026, month: 6, day: 18, hour: 0, minute: 0 });
    expect(durMs).toBeNull(); // a move keeps the span length
    expect(mode).toBe("all");
    expect(recurrenceId).toBeNull();
    // A committed drag must NOT also select the event (the trailing click is swallowed).
    expect(selectedEventId()).toBeNull();
  });

  it("treats a drop back on the same column as a no-op (selects, no reschedule)", () => {
    seed({ h: allDayEvent() }, ["h"]);
    render(() => <WeekGrid columns={7} />);
    const bar = screen.getByRole("button", { name: /Holiday/ });
    fireEvent.pointerDown(bar, { clientX: 220, clientY: 10, pointerId: 1, button: 0 }); // col 2
    fireEvent.pointerMove(bar, { clientX: 290, clientY: 10, pointerId: 1 }); // still col 2 (Δ0 days)
    fireEvent.pointerUp(bar, { clientX: 290, clientY: 10, pointerId: 1 });
    expect(rescheduleMock).not.toHaveBeenCalled();
    // No drag committed → the trailing click selects as normal.
    fireEvent.click(bar);
    expect(selectedEventId()).toBe("h");
  });

  it("treats a press that doesn't pass the threshold as a click (selects, no reschedule)", () => {
    seed({ h: allDayEvent() }, ["h"]);
    render(() => <WeekGrid columns={7} />);
    const bar = screen.getByRole("button", { name: /Holiday/ });
    fireEvent.pointerDown(bar, { clientX: 250, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 252, clientY: 11, pointerId: 1 }); // < 4px threshold
    fireEvent.pointerUp(bar, { clientX: 252, clientY: 11, pointerId: 1 });
    fireEvent.click(bar);
    expect(rescheduleMock).not.toHaveBeenCalled();
    expect(selectedEventId()).toBe("h");
  });

  it("does not start a drag on a read-only calendar's all-day event", () => {
    setCalendarReady(true);
    setCalendars(
      reconcile({
        c1: {
          ...writableCal(),
          myRights: { ...writableCal().myRights, mayWriteAll: false, mayWriteOwn: false },
        },
      }),
    );
    setCalendarEvents(reconcile({ h: allDayEvent() }));
    setEventIds(["h"]);
    render(() => <WeekGrid columns={7} />);
    const bar = screen.getByRole("button", { name: /Holiday/ });
    fireEvent.pointerDown(bar, { clientX: 250, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 450, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 450, clientY: 10, pointerId: 1 });
    expect(rescheduleMock).not.toHaveBeenCalled();
  });

  it("prompts for scope on a recurring all-day drag and reschedules with the chosen mode", () => {
    seed(
      {
        h: allDayEvent({
          title: "Sprint week",
          recurrenceId: "2026-06-16T00:00:00",
          recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly" },
        }),
      },
      ["h"],
    );
    render(() => <WeekGrid columns={7} />);
    const bar = screen.getByRole("button", { name: /Sprint week/ });
    fireEvent.pointerDown(bar, { clientX: 250, clientY: 10, pointerId: 1, button: 0 }); // col 2
    fireEvent.pointerMove(bar, { clientX: 450, clientY: 10, pointerId: 1 }); // col 4 → +2 days
    fireEvent.pointerUp(bar, { clientX: 450, clientY: 10, pointerId: 1 });

    // The write waits for the scope choice.
    expect(rescheduleMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "This and following events" }));

    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [occId, newStart, durMs, mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
    expect(occId).toBe("h");
    expect(newStart).toMatchObject({ month: 6, day: 18, hour: 0 });
    expect(durMs).toBeNull();
    expect(mode).toBe("following");
    expect(recurrenceId).toBe("2026-06-16T00:00:00");
  });

  it("shows a held ghost bar at the dropped span while a recurring move awaits its scope choice", () => {
    seed(
      {
        h: allDayEvent({
          title: "Sprint week",
          recurrenceId: "2026-06-16T00:00:00",
          recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly" },
        }),
      },
      ["h"],
    );
    const { container } = render(() => <WeekGrid columns={7} />);
    const bar = screen.getByRole("button", { name: /Sprint week/ });
    fireEvent.pointerDown(bar, { clientX: 250, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: 450, clientY: 10, pointerId: 1 }); // +2 days → col 4
    fireEvent.pointerUp(bar, { clientX: 450, clientY: 10, pointerId: 1 });
    // The dialog is open (recurring) and the ghost is held at the target column (col 4 → grid-column 5).
    const ghost = container.querySelector(".week-allday-bar-ghost") as HTMLElement;
    expect(ghost).toBeTruthy();
    expect(ghost.style.gridColumn).toBe("5 / 6");
  });
});
