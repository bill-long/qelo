import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { MonthGrid } from "@/components/calendar/MonthGrid";
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
  calendarAnchor,
  calendarViewMode,
  selectedEventId,
  setCalendarAnchor,
  setCalendarDisplayZone,
  setCalendarViewMode,
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

// Seed the store with a loaded June 2026 window, then render the grid. The load/nav wiring lives in
// CalendarMain, so MonthGrid is tested as a pure render over the store.
function seed(events: Record<string, CalendarEvent>, ids: string[]) {
  setCalendarReady(true);
  setCalendars(reconcile({ c1: writableCal() }));
  setCalendarEvents(reconcile(events));
  setEventIds(ids);
}

// The June 2026 grid is 5 Sun-start weeks (Sun May 31 … Sat Jul 4). Mock the `.month-weeks` rect 700px
// wide (7 cols × 100px) by 500px tall (5 rows × 100px), so clientX/clientY map directly to a cell:
// col = floor(x/100), row = floor(y/100). jsdom returns a zero rect otherwise. setPointerCapture is
// unimplemented in jsdom → stub it.
//  Row 0 May31–Jun6 · Row 1 Jun7–13 · Row 2 Jun14–20 · Row 3 Jun21–27 · Row 4 Jun28–Jul4.
//  Wed Jun 17 = row 2, col 3 → (x 350, y 250). Sat Jun 20 = row 2, col 6 → (x 650, y 250).
let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
// jsdom implements neither setPointerCapture nor releasePointerCapture; stub them ONLY when absent so a
// future jsdom that adds a real implementation isn't clobbered, and in afterEach delete only what we
// actually added (so we never remove a member we didn't create). The stubbed-members list is captured
// per run.
const POINTER_CAPTURE_METHODS = ["setPointerCapture", "releasePointerCapture"] as const;
let stubbedPointerCapture: (typeof POINTER_CAPTURE_METHODS)[number][] = [];
beforeEach(() => {
  rescheduleMock.mockClear();
  rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 700,
    height: 500,
    right: 700,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  stubbedPointerCapture = POINTER_CAPTURE_METHODS.filter((m) => !(m in HTMLElement.prototype));
  for (const m of stubbedPointerCapture) {
    HTMLElement.prototype[m] = () => {};
  }
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
  setCalendarDisplayZone(LOCAL_ZONE);
  setCalendarViewMode("month");
  setCalendarAnchor(new Date(2026, 5, 1)); // June 2026
});
afterEach(() => {
  cleanup();
  rectSpy?.mockRestore();
  for (const m of stubbedPointerCapture) {
    delete (HTMLElement.prototype as Partial<HTMLElement>)[m];
  }
  stubbedPointerCapture = [];
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
  setCalendarDisplayZone(LOCAL_ZONE);
  setCalendarViewMode("month");
});

// Wed Jun 17 cell center (row 2, col 3) and Sat Jun 20 (row 2, col 6).
const JUN17 = { clientX: 350, clientY: 250 };
const JUN20 = { clientX: 650, clientY: 250 };
const JUN24 = { clientX: 350, clientY: 350 }; // row 3, col 3

describe("MonthGrid", () => {
  it("renders single-day chips and multi-day bars as buttons", () => {
    seed(
      {
        chip: ev({ id: "chip", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }),
        bar: ev({
          id: "bar",
          title: "Conference",
          start: "2026-06-16T00:00:00",
          duration: "P3D",
          showWithoutTime: true,
        }),
      },
      ["chip", "bar"],
    );
    render(() => <MonthGrid />);
    expect(screen.getByRole("button", { name: /Standup/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Conference/ })).toBeTruthy();
  });

  it("selects an event when its chip is clicked", () => {
    seed(
      {
        chip: ev({ id: "chip", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }),
      },
      ["chip"],
    );
    render(() => <MonthGrid />);
    fireEvent.click(screen.getByRole("button", { name: /Standup/ }));
    expect(selectedEventId()).toBe("chip");
  });

  it("filters by the selected calendar", () => {
    seed(
      {
        a: ev({ id: "a", title: "Mine", start: "2026-06-17T09:00:00", calendarIds: { c1: true } }),
        b: ev({
          id: "b",
          title: "Theirs",
          start: "2026-06-18T09:00:00",
          calendarIds: { c2: true },
        }),
      },
      ["a", "b"],
    );
    setSelectedCalendarId("c1");
    render(() => <MonthGrid />);
    expect(screen.getByRole("button", { name: /Mine/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Theirs/ })).toBeNull();
  });

  it("collapses overflow into a '+N more' that opens that day's time-grid", () => {
    // Four chips on the same day exceed the 3 visible lanes → one hidden → "+1 more".
    const events: Record<string, CalendarEvent> = {};
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = `e${i}`;
      events[id] = ev({ id, title: `Event ${i}`, start: "2026-06-17T09:00:00", duration: "PT1H" });
      ids.push(id);
    }
    seed(events, ids);
    render(() => <MonthGrid />);
    const more = screen.getByRole("button", { name: /1 more event\b/ });
    expect(more.textContent).toContain("+1 more");
    fireEvent.click(more);
    // The overflow drills into the Day time-grid anchored at that day.
    expect(calendarViewMode()).toBe("day");
    expect(calendarAnchor()).toEqual(new Date(2026, 5, 17));
  });

  describe("drag-to-move", () => {
    it("drags a chip to a later day and reschedules by the whole-day delta (non-recurring → 'all')", () => {
      seed(
        { c: ev({ id: "c", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) },
        ["c"],
      );
      render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Standup/ });
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { ...JUN20, pointerId: 1 }); // → Jun 20 (+3 days)
      fireEvent.pointerUp(chip, { ...JUN20, pointerId: 1 });

      expect(rescheduleMock).toHaveBeenCalledTimes(1);
      const [occId, newStart, durMs, mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
      expect(occId).toBe("c");
      // The SOURCE start shifts by the whole-day delta, time-of-day preserved.
      expect(newStart).toMatchObject({ year: 2026, month: 6, day: 20, hour: 9, minute: 0 });
      expect(durMs).toBeNull(); // a move keeps the duration
      expect(mode).toBe("all");
      expect(recurrenceId).toBeNull();
      // A committed drag must NOT also select the event (the trailing click is swallowed).
      expect(selectedEventId()).toBeNull();
    });

    it("drags ACROSS week rows (a 2D cell hit-test, not just a column shift)", () => {
      seed(
        { c: ev({ id: "c", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) },
        ["c"],
      );
      render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Standup/ });
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { ...JUN24, pointerId: 1 }); // a row down → Jun 24 (+7 days)
      fireEvent.pointerUp(chip, { ...JUN24, pointerId: 1 });
      const [, newStart] = rescheduleMock.mock.calls[0] ?? [];
      expect(newStart).toMatchObject({ year: 2026, month: 6, day: 24, hour: 9 });
    });

    it("keeps an all-day bar's T00:00:00 when moved", () => {
      seed(
        {
          a: ev({
            id: "a",
            title: "Holiday",
            start: "2026-06-17T00:00:00",
            duration: "P1D",
            showWithoutTime: true,
          }),
        },
        ["a"],
      );
      render(() => <MonthGrid />);
      const bar = screen.getByRole("button", { name: /Holiday/ });
      fireEvent.pointerDown(bar, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(bar, { ...JUN20, pointerId: 1 });
      fireEvent.pointerUp(bar, { ...JUN20, pointerId: 1 });
      const [, newStart, durMs] = rescheduleMock.mock.calls[0] ?? [];
      expect(newStart).toMatchObject({ month: 6, day: 20, hour: 0, minute: 0, second: 0 });
      expect(durMs).toBeNull();
    });

    it("treats a press that doesn't pass the threshold as a click (selects, no reschedule)", () => {
      seed(
        { c: ev({ id: "c", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) },
        ["c"],
      );
      render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Standup/ });
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { clientX: 352, clientY: 251, pointerId: 1 }); // < threshold
      fireEvent.pointerUp(chip, { clientX: 352, clientY: 251, pointerId: 1 });
      fireEvent.click(chip);
      expect(rescheduleMock).not.toHaveBeenCalled();
      expect(selectedEventId()).toBe("c");
    });

    it("treats a drag dropped back on the SAME cell as a no-op (selects, no reschedule)", () => {
      seed(
        { c: ev({ id: "c", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) },
        ["c"],
      );
      render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Standup/ });
      // Move past the 4px threshold (moved=true) but to another cell and back to Jun 17 → zero delta.
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { ...JUN20, pointerId: 1 });
      fireEvent.pointerMove(chip, { ...JUN17, pointerId: 1 });
      fireEvent.pointerUp(chip, { ...JUN17, pointerId: 1 });
      fireEvent.click(chip);
      expect(rescheduleMock).not.toHaveBeenCalled();
      expect(selectedEventId()).toBe("c");
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
          c: ev({ id: "c", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }),
        }),
      );
      setEventIds(["c"]);
      render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Standup/ });
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { ...JUN20, pointerId: 1 });
      fireEvent.pointerUp(chip, { ...JUN20, pointerId: 1 });
      expect(rescheduleMock).not.toHaveBeenCalled();
    });

    it("highlights the single drop-target cell and dims the dragged segment while dragging", async () => {
      seed(
        { c: ev({ id: "c", title: "Standup", start: "2026-06-17T09:00:00", duration: "PT1H" }) },
        ["c"],
      );
      const { container } = render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Standup/ });
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { ...JUN20, pointerId: 1 });
      // Exactly one cell is highlighted (the shared signal is naturally exclusive), and the source dims.
      expect(container.querySelectorAll(".month-cell.is-drop-target").length).toBe(1);
      expect(container.querySelector(".month-event.is-dragging")).toBeTruthy();
      fireEvent.pointerUp(chip, { ...JUN20, pointerId: 1 });
      // The highlight is HELD on the target while the (mocked, async) write is in flight…
      expect(container.querySelectorAll(".month-cell.is-drop-target").length).toBe(1);
      // …and clears once the write resolves (committing → null).
      await Promise.resolve();
      expect(container.querySelectorAll(".month-cell.is-drop-target").length).toBe(0);
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
      render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Daily sync/ });
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { ...JUN20, pointerId: 1 });
      fireEvent.pointerUp(chip, { ...JUN20, pointerId: 1 });

      // The write waits for the scope choice.
      expect(rescheduleMock).not.toHaveBeenCalled();
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain("Move"); // worded as a move (not "Resize")
      fireEvent.click(screen.getByRole("button", { name: "This and following events" }));

      expect(rescheduleMock).toHaveBeenCalledTimes(1);
      const [occId, newStart, durMs, mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
      expect(occId).toBe("r");
      expect(newStart).toMatchObject({ day: 20, hour: 9 });
      expect(durMs).toBeNull();
      expect(mode).toBe("following");
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
            recurrenceRule: { "@type": "RecurrenceRule", frequency: "daily" },
          }),
        },
        ["r"],
      );
      render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Daily sync/ });
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { ...JUN20, pointerId: 1 });
      fireEvent.pointerUp(chip, { ...JUN20, pointerId: 1 });

      expect(rescheduleMock).not.toHaveBeenCalled();
      const thisBtn = screen.getByRole("button", { name: "This event" });
      expect(thisBtn.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(thisBtn); // a no-op without a recurrenceId
      expect(rescheduleMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "All events" }));
      expect(rescheduleMock).toHaveBeenCalledTimes(1);
      const [, , , mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
      expect(mode).toBe("all");
      expect(recurrenceId).toBeNull();
    });

    it("Escape cancels a pending recurring scope choice (no write)", () => {
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
      render(() => <MonthGrid />);
      const chip = screen.getByRole("button", { name: /Daily sync/ });
      fireEvent.pointerDown(chip, { ...JUN17, pointerId: 1, button: 0 });
      fireEvent.pointerMove(chip, { ...JUN20, pointerId: 1 });
      fireEvent.pointerUp(chip, { ...JUN20, pointerId: 1 });
      expect(screen.getByRole("dialog")).toBeTruthy();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(rescheduleMock).not.toHaveBeenCalled();
    });
  });
});
