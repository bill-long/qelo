import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { CalendarList } from "@/components/calendar/CalendarList";
import type { Calendar } from "@/jmap/types";
import { resetCalendar, setCalendars } from "@/stores/calendar";
import { selectedCalendarId, selectedEventId, setSelectedEventId } from "@/stores/ui";

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

function reset() {
  resetCalendar();
  setSelectedEventId(null);
}

afterEach(() => {
  cleanup();
  reset();
});

describe("CalendarList", () => {
  it("lists 'All calendars' plus each calendar", () => {
    reset();
    setCalendars({
      b: calendar({ name: "Personal" }),
      w: calendar({ id: "w", name: "Work", isDefault: false }),
    });
    render(() => <CalendarList />);
    expect(screen.getByRole("button", { name: /All calendars/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Personal/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Work/ })).toBeTruthy();
  });

  it("selecting a calendar sets the filter and clears the open event", () => {
    // The previously-selected event may not be in the newly-filtered agenda, so switching calendars
    // must reset the selection (the list-filter ↔ detail-selection pair).
    reset();
    setCalendars({ b: calendar({ name: "Personal" }), w: calendar({ id: "w", name: "Work" }) });
    setSelectedEventId("some-event");

    render(() => <CalendarList />);
    fireEvent.click(screen.getByRole("button", { name: /Work/ }));
    expect(selectedCalendarId()).toBe("w");
    expect(selectedEventId()).toBeNull();
  });
});
