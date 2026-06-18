import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeekGrid } from "@/components/calendar/WeekGrid";
import type { CalendarEvent } from "@/jmap/types";
import { resetCalendar, setCalendarEvents, setCalendarReady, setEventIds } from "@/stores/calendar";
import {
  selectedEventId,
  setCalendarAnchor,
  setCalendarViewMode,
  setSelectedCalendarId,
  setSelectedEventId,
} from "@/stores/ui";

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return { "@type": "Event", id: "e", calendarIds: { c1: true }, ...partial };
}

function seed(events: Record<string, CalendarEvent>, ids: string[]) {
  setCalendarReady(true);
  setCalendarEvents(reconcile(events));
  setEventIds(ids);
}

beforeEach(() => {
  // Fake only Date so the now-indicator's day is deterministic; SolidJS timers stay real (the
  // WeekGrid's once-a-minute setInterval never needs to fire in these tests).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 5, 17, 9, 30)); // Wed Jun 17 2026, 09:30 local
  resetCalendar();
  setSelectedCalendarId(null);
  setSelectedEventId(null);
  setCalendarViewMode("week");
  setCalendarAnchor(new Date(2026, 5, 17)); // week Sun Jun 14 … Sat Jun 20
});
afterEach(() => {
  cleanup();
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
});
