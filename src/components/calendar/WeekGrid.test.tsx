import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { WeekGrid } from "@/components/calendar/WeekGrid";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import {
  rescheduleEvent,
  resetCalendar,
  setCalendarEvents,
  setCalendarReady,
  setCalendars,
  setEventIds,
} from "@/stores/calendar";
import {
  selectedEventId,
  setCalendarAnchor,
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
  // jsdom doesn't implement pointer capture — stub it so the drag handlers don't throw.
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
  setCalendarViewMode("week");
  setCalendarAnchor(new Date(2026, 5, 17)); // week Sun Jun 14 … Sat Jun 20
});
afterEach(() => {
  cleanup();
  rectSpy?.mockRestore();
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
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
    fireEvent.click(screen.getByRole("button", { name: "All events" }));
    expect(rescheduleMock).toHaveBeenCalledTimes(1);
    const [, , , mode, recurrenceId] = rescheduleMock.mock.calls[0] ?? [];
    expect(mode).toBe("all");
    expect(recurrenceId).toBeNull();
  });
});
