import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonthGrid } from "@/components/calendar/MonthGrid";
import type { CalendarEvent } from "@/jmap/types";
import { resetCalendar, setCalendarEvents, setCalendarReady, setEventIds } from "@/stores/calendar";
import {
  calendarAnchor,
  calendarViewMode,
  selectedEventId,
  setCalendarAnchor,
  setCalendarViewMode,
  setSelectedCalendarId,
  setSelectedEventId,
} from "@/stores/ui";

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return { "@type": "Event", id: "e", calendarIds: { c1: true }, ...partial };
}

// Seed the store with a loaded June 2026 window, then render the grid. The load/nav wiring lives in
// CalendarMain, so MonthGrid is tested as a pure render over the store.
function seed(events: Record<string, CalendarEvent>, ids: string[]) {
  setCalendarReady(true);
  setCalendarEvents(reconcile(events));
  setEventIds(ids);
}

beforeEach(() => {
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
  setCalendarViewMode("month");
  setCalendarAnchor(new Date(2026, 5, 1)); // June 2026
});
afterEach(() => {
  cleanup();
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
  setCalendarViewMode("month");
});

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

  it("collapses overflow into a '+N more' that opens that day's agenda", () => {
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
    // Until the day time-grid lands, the overflow opens the agenda anchored at that day (built +
    // reachable), not the not-yet-built day view.
    expect(calendarViewMode()).toBe("agenda");
    expect(calendarAnchor()).toEqual(new Date(2026, 5, 17));
  });
});
