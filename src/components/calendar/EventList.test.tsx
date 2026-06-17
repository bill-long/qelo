import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { EventList } from "@/components/calendar/EventList";
import type { CalendarEvent } from "@/jmap/types";
import { resetCalendar, setCalendarEvents, setCalendarReady, setEventIds } from "@/stores/calendar";
import { selectedEventId, setSelectedCalendarId, setSelectedEventId } from "@/stores/ui";

function event(partial: Partial<CalendarEvent>): CalendarEvent {
  return { "@type": "Event", id: "e", calendarIds: { b: true }, ...partial };
}

function reset() {
  resetCalendar();
  setSelectedEventId(null);
  setSelectedCalendarId(null);
}

afterEach(() => {
  cleanup();
  reset();
});

describe("EventList", () => {
  it("renders events grouped by day and selects a row on click", () => {
    reset();
    setCalendarEvents({
      a: event({ id: "a", title: "Standup", start: "2026-09-07T09:00:00", duration: "PT30M" }),
      b: event({ id: "b", title: "Review", start: "2026-09-08T11:00:00", duration: "PT1H" }),
    });
    setEventIds(["a", "b"]);
    setCalendarReady(true); // loadCalendar() short-circuits, so the test needs no client

    render(() => <EventList />);
    // Both day headings render.
    expect(screen.getByRole("heading", { name: "Mon, Sep 7" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tue, Sep 8" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Standup/ }));
    expect(selectedEventId()).toBe("a");
  });

  it("filters the agenda to the selected calendar", () => {
    reset();
    setCalendarEvents({
      a: event({
        id: "a",
        title: "Personal lunch",
        start: "2026-09-07T12:00:00",
        calendarIds: { b: true },
      }),
      w: event({
        id: "w",
        title: "Work sync",
        start: "2026-09-07T15:00:00",
        calendarIds: { work: true },
      }),
    });
    setEventIds(["a", "w"]);
    setCalendarReady(true);

    render(() => <EventList />);
    // All calendars (null): both show.
    expect(screen.queryByRole("button", { name: /Personal lunch/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Work sync/ })).toBeTruthy();

    // Filter to the work calendar: only its event remains.
    setSelectedCalendarId("work");
    expect(screen.queryByRole("button", { name: /Personal lunch/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Work sync/ })).toBeTruthy();
  });

  it("shows an empty state when the window has no events", () => {
    reset();
    setCalendarReady(true);
    render(() => <EventList />);
    expect(screen.getByText("No upcoming events")).toBeTruthy();
  });
});
