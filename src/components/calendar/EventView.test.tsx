import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// formatDayHeading appends the year only when it differs from the current year, so pin the clock
// (Date only — leave real timers so SolidJS isn't disturbed) to keep "Mon, Sep 7" deterministic.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-17T12:00:00"));
});

afterEach(() => {
  vi.useRealTimers();
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

const readonlyRights: Calendar["myRights"] = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: false,
  mayWriteOwn: false,
  mayUpdatePrivate: false,
  mayRSVP: false,
  mayShare: false,
  mayDelete: false,
};

describe("EventView edit affordance", () => {
  it("shows the Edit button when the event's calendar grants write rights", () => {
    reset();
    setCalendars({ b: calendar({}) }); // default rights include mayWriteAll
    setCalendarEvents({ e: event({ id: "e", title: "Standup", start: "2026-09-07T09:00:00" }) });
    setSelectedEventId("e");

    render(() => <EventView />);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("hides the Edit button for an event in a read-only calendar", () => {
    reset();
    setCalendars({ b: calendar({ myRights: readonlyRights }) });
    setCalendarEvents({ e: event({ id: "e", title: "Standup", start: "2026-09-07T09:00:00" }) });
    setSelectedEventId("e");

    render(() => <EventView />);
    expect(screen.getByRole("heading", { name: "Standup", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

// A calendar that grants write but NOT delete — proves the two affordances gate independently.
const writeNoDeleteRights: Calendar["myRights"] = {
  mayReadFreeBusy: true,
  mayReadItems: true,
  mayWriteAll: true,
  mayWriteOwn: true,
  mayUpdatePrivate: true,
  mayRSVP: true,
  mayShare: true,
  mayDelete: false,
};

describe("EventView delete affordance", () => {
  it("shows the Delete button when the event's calendar grants mayDelete", () => {
    reset();
    setCalendars({ b: calendar({}) }); // default rights include mayDelete
    setCalendarEvents({ e: event({ id: "e", title: "Standup", start: "2026-09-07T09:00:00" }) });
    setSelectedEventId("e");

    render(() => <EventView />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("hides the Delete button for a calendar that grants write but not delete", () => {
    reset();
    setCalendars({ b: calendar({ myRights: writeNoDeleteRights }) });
    setCalendarEvents({ e: event({ id: "e", title: "Standup", start: "2026-09-07T09:00:00" }) });
    setSelectedEventId("e");

    render(() => <EventView />);
    // Edit stays (write granted), Delete is gone (delete not granted) — the gates are independent.
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("swaps in a two-step confirm on Delete, and Cancel dismisses it", () => {
    reset();
    setCalendars({ b: calendar({}) });
    setCalendarEvents({ e: event({ id: "e", title: "Standup", start: "2026-09-07T09:00:00" }) });
    setSelectedEventId("e");

    render(() => <EventView />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // The confirm row appears (a labelled group + a prompt naming the event); the plain Edit affordance
    // is replaced.
    expect(screen.getByRole("group", { name: "Confirm delete event" })).toBeTruthy();
    expect(screen.getByText(/Delete “Standup”\?/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Back to the plain actions; the confirm is gone.
    expect(screen.queryByRole("group", { name: "Confirm delete event" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("warns that a recurring delete removes the whole series", () => {
    reset();
    setCalendars({ b: calendar({}) });
    setCalendarEvents({
      e: event({
        id: "e",
        title: "Weekly",
        start: "2026-09-07T09:00:00",
        recurrenceRule: { frequency: "weekly" },
      }),
    });
    setSelectedEventId("e");

    render(() => <EventView />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("This deletes the whole repeating series.")).toBeTruthy();
  });

  it("does not warn about a series for a non-recurring event", () => {
    reset();
    setCalendars({ b: calendar({}) });
    setCalendarEvents({ e: event({ id: "e", title: "One-off", start: "2026-09-07T09:00:00" }) });
    setSelectedEventId("e");

    render(() => <EventView />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByText("This deletes the whole repeating series.")).toBeNull();
  });

  it("resets a half-armed confirm when the selected event changes", () => {
    reset();
    setCalendars({ b: calendar({}) });
    setCalendarEvents({
      a: event({ id: "a", title: "First", start: "2026-09-07T09:00:00" }),
      b2: event({ id: "b2", title: "Second", start: "2026-09-08T09:00:00" }),
    });
    setSelectedEventId("a");

    render(() => <EventView />);
    // Arm the confirm on event A, then switch the selection — the confirm must not carry over (Show
    // doesn't re-mount EventDetail between two truthy events, so the on(event.id) reset is what clears).
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("group", { name: "Confirm delete event" })).toBeTruthy();

    setSelectedEventId("b2");
    expect(screen.getByRole("heading", { name: "Second", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Confirm delete event" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
