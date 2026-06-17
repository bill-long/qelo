import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { EventView } from "@/components/calendar/EventView";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import { resetCalendar, setCalendarEvents, setCalendars } from "@/stores/calendar";
import { setSelectedCalendarId, setSelectedEventId } from "@/stores/ui";

function calendar(partial: Partial<Calendar>): Calendar {
  return {
    id: "b",
    name: "Personal",
    description: null,
    color: null,
    timeZone: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: false,
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
    ...partial,
  };
}

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

describe("EventView", () => {
  it("shows the empty state when nothing is selected", () => {
    reset();
    render(() => <EventView />);
    expect(screen.getByText("Select an event")).toBeTruthy();
  });

  it("renders the focused-complete detail of the selected event", () => {
    reset();
    setCalendars({ b: calendar({ name: "Personal" }) });
    setCalendarEvents({
      e: event({
        id: "e",
        title: "Team standup",
        start: "2026-09-07T09:00:00",
        duration: "PT30M",
        timeZone: "America/New_York",
        status: "confirmed",
        freeBusyStatus: "busy",
        privacy: "public",
        description: "Daily sync",
        locations: { l1: { "@type": "Location", name: "Room A" } },
        participants: { p1: { "@type": "Participant", name: "Ada Lovelace" } },
      }),
    });
    setSelectedEventId("e");

    render(() => <EventView />);
    expect(screen.getByRole("heading", { name: "Team standup", level: 1 })).toBeTruthy();
    expect(screen.getByText("Mon, Sep 7")).toBeTruthy();
    expect(screen.getByText("09:00 – 09:30")).toBeTruthy();
    expect(screen.getByText("America/New_York")).toBeTruthy();
    expect(screen.getByText("Room A")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("Daily sync")).toBeTruthy();
    expect(screen.getByText("Personal")).toBeTruthy();
    // The status/free-busy/privacy badges all render.
    expect(screen.getByText("confirmed")).toBeTruthy();
    expect(screen.getByText("busy")).toBeTruthy();
    expect(screen.getByText("public")).toBeTruthy();
  });

  it("summarizes a base recurrence rule and marks an expanded occurrence generically", () => {
    reset();
    setCalendars({ b: calendar({}) });
    setCalendarEvents({
      base: event({
        id: "base",
        title: "Weekly",
        start: "2026-09-07T09:00:00",
        recurrenceRule: { frequency: "weekly", byDay: [{ day: "mo" }] },
      }),
      occ: event({
        id: "occ",
        title: "Occurrence",
        start: "2026-09-14T09:00:00",
        recurrenceId: "2026-09-14T09:00:00",
      }),
    });

    setSelectedEventId("base");
    const { unmount } = render(() => <EventView />);
    expect(screen.getByText("↻ Weekly on Monday")).toBeTruthy();
    unmount();

    setSelectedEventId("occ");
    render(() => <EventView />);
    expect(screen.getByText("↻ Repeating event")).toBeTruthy();
  });
});
