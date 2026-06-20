import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventView } from "@/components/calendar/EventView";
import { NewEventButton } from "@/components/calendar/NewEventButton";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import { dragCreateSeed, LOCAL_ZONE } from "@/lib/calendar";
import { resetCalendar, setCalendarEvents, setCalendars } from "@/stores/calendar";
import {
  createSeed,
  creatingEvent,
  setCreateSeed,
  setCreatingEvent,
  setSelectedCalendarId,
  setSelectedEventId,
} from "@/stores/ui";

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
  setCreatingEvent(false);
  setCreateSeed(null);
}

// emptyEditableEvent reads the clock; pin it so the seeded create form is deterministic.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-17T12:00:00"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  reset();
});

describe("NewEventButton", () => {
  it("is hidden until a writable calendar exists, then offers to create", () => {
    reset();
    render(() => <NewEventButton />);
    expect(screen.queryByRole("button", { name: /new event/i })).toBeNull();

    // A read-only calendar still offers nothing to create into.
    setCalendars({ r: calendar({ id: "r", myRights: readonlyRights }) });
    expect(screen.queryByRole("button", { name: /new event/i })).toBeNull();

    setCalendars({ b: calendar({}) });
    expect(screen.getByRole("button", { name: /new event/i })).toBeTruthy();
  });

  it("opens the create form even when an event is already selected", () => {
    // The regression guard (contacts batched-handler trap): EventView's on(selectedEventId) effect
    // runs AFTER the (batched) click handler. If the button also cleared the selection, that effect
    // would reset creatingEvent back to false and the form would never open. With an event selected,
    // clicking New must still open it.
    reset();
    setCalendars({ b: calendar({}) });
    setCalendarEvents({ e: event({ id: "e", title: "Standup", start: "2026-09-07T09:00:00" }) });
    setSelectedEventId("e");

    render(() => (
      <>
        <NewEventButton />
        <EventView />
      </>
    ));

    // The selected event's detail shows; the create form does not yet.
    expect(screen.getByRole("heading", { name: "Standup", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "New event" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /new event/i }));

    expect(creatingEvent()).toBe(true);
    expect(screen.getByRole("heading", { name: "New event" })).toBeTruthy();
  });

  it("clears a stale drag-to-create seed so a plain New event opens the default slot", () => {
    // A prior drag-to-create left a swept range in createSeed. Clicking "+ New event" must clear it so the
    // create form opens its default next-hour slot, not the stale swept range (the ui.ts seed-leak guard).
    reset();
    setCalendars({ b: calendar({}) });
    setCreateSeed(dragCreateSeed("2026-09-07", 9 * 60, 11 * 60, "America/New_York"));
    expect(createSeed()).not.toBeNull();

    render(() => (
      <>
        <NewEventButton />
        <EventView />
      </>
    ));
    fireEvent.click(screen.getByRole("button", { name: /new event/i }));

    expect(creatingEvent()).toBe(true);
    expect(createSeed()).toBeNull();
    // The form shows the default slot, NOT the stale swept range: the default is anchored to the display
    // zone (LOCAL_ZONE) at the next-hour slot, whereas the cleared seed was zoned America/New_York at 09:00.
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe(LOCAL_ZONE);
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).not.toBe("2026-09-07T09:00");
  });

  it("clears the create form when the Calendar view unmounts (leaving the surface)", () => {
    // creatingEvent is global UI state, so a half-filled create must not resurface after switching
    // away from Calendar and back. EventView's onCleanup clears it when the surface unmounts.
    reset();
    setCalendars({ b: calendar({}) });
    const { unmount } = render(() => <EventView />);
    setCreatingEvent(true);
    expect(screen.getByRole("heading", { name: "New event" })).toBeTruthy();

    unmount();
    expect(creatingEvent()).toBe(false);
  });
});
