import { describe, expect, it } from "vitest";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import {
  compareCalendars,
  compareEvents,
  createdEventFor,
  createEventBody,
  createEventError,
  dayKey,
  defaultWritableCalendarId,
  type EditableEvent,
  editableHasContent,
  emptyEditableEvent,
  eventDisplayTitle,
  eventEndParts,
  formatDayHeading,
  formatTimeRange,
  freshOccurrenceIdForBase,
  groupEventsByDay,
  isAllDay,
  isRecurring,
  parseDateParts,
  parseDuration,
  recurrenceSummary,
  writableCalendars,
} from "./calendar";

function event(partial: Partial<CalendarEvent>): CalendarEvent {
  return { "@type": "Event", id: "e", ...partial };
}

function cal(partial: Partial<Calendar>): Calendar {
  return {
    id: "x",
    name: "Cal",
    description: null,
    color: null,
    timeZone: null,
    sortOrder: 0,
    isDefault: false,
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

describe("parseDateParts", () => {
  it("parses a local date-time", () => {
    expect(parseDateParts("2026-09-07T09:30:00")).toEqual({
      year: 2026,
      month: 9,
      day: 7,
      hour: 9,
      minute: 30,
      second: 0,
    });
  });

  it("parses a bare date as midnight", () => {
    expect(parseDateParts("2026-09-07")).toEqual({
      year: 2026,
      month: 9,
      day: 7,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });

  it("captures seconds (discarding any fraction)", () => {
    expect(parseDateParts("2026-09-07T09:30:15.500")).toEqual({
      year: 2026,
      month: 9,
      day: 7,
      hour: 9,
      minute: 30,
      second: 15,
    });
  });

  it("returns null for undefined, malformed, trailing, or out-of-range input", () => {
    expect(parseDateParts(undefined)).toBeNull();
    expect(parseDateParts("not a date")).toBeNull();
    // Trailing characters (a JSCalendar LocalDateTime has no Z/offset) → rejected, not truncated.
    expect(parseDateParts("2026-09-07T09:00:00Z")).toBeNull();
    expect(parseDateParts("2026-09-07 garbage")).toBeNull();
    // Out-of-range components → rejected (would otherwise normalize silently).
    expect(parseDateParts("2026-13-40")).toBeNull();
    expect(parseDateParts("2026-00-10")).toBeNull();
    expect(parseDateParts("2026-09-07T25:00:00")).toBeNull();
    expect(parseDateParts("2026-09-07T09:60:00")).toBeNull();
    // Impossible calendar days (per-month + leap-year), which UTC math would normalize.
    expect(parseDateParts("2026-02-31")).toBeNull();
    expect(parseDateParts("2026-04-31")).toBeNull();
    expect(parseDateParts("2026-02-29")).toBeNull(); // 2026 is not a leap year
  });

  it("accepts a valid leap day", () => {
    expect(parseDateParts("2028-02-29")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });
});

describe("parseDuration", () => {
  it("parses hour/minute/day/week durations", () => {
    expect(parseDuration("PT1H")).toEqual({ years: 0, months: 0, days: 0, ms: 3600_000 });
    expect(parseDuration("PT30M")).toEqual({ years: 0, months: 0, days: 0, ms: 1800_000 });
    expect(parseDuration("P1D")).toEqual({ years: 0, months: 0, days: 1, ms: 0 });
    expect(parseDuration("P1W")).toEqual({ years: 0, months: 0, days: 7, ms: 0 });
  });

  it("parses a combined duration", () => {
    expect(parseDuration("P1Y2M3DT4H5M")).toEqual({
      years: 1,
      months: 2,
      days: 3,
      ms: (4 * 3600 + 5 * 60) * 1000,
    });
  });

  it("returns null for a contentless or malformed duration", () => {
    expect(parseDuration("P")).toBeNull();
    expect(parseDuration("PT")).toBeNull();
    expect(parseDuration("1H")).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });
});

describe("isAllDay / isRecurring", () => {
  it("flags all-day only when showWithoutTime is true", () => {
    expect(isAllDay(event({ showWithoutTime: true }))).toBe(true);
    expect(isAllDay(event({}))).toBe(false);
  });

  it("flags recurring for a base rule or an expanded occurrence", () => {
    expect(isRecurring(event({ recurrenceRule: { frequency: "weekly" } }))).toBe(true);
    expect(isRecurring(event({ recurrenceId: "2026-09-14T09:00:00" }))).toBe(true);
    expect(isRecurring(event({}))).toBe(false);
  });
});

describe("eventEndParts", () => {
  it("adds a sub-day duration without timezone drift", () => {
    const end = eventEndParts(event({ start: "2026-09-07T09:00:00", duration: "PT30M" }));
    expect(end).toEqual({ year: 2026, month: 9, day: 7, hour: 9, minute: 30, second: 0 });
  });

  it("rolls over midnight", () => {
    const end = eventEndParts(event({ start: "2026-09-07T23:30:00", duration: "PT1H" }));
    expect(end).toEqual({ year: 2026, month: 9, day: 8, hour: 0, minute: 30, second: 0 });
  });

  it("adds whole days for an all-day duration", () => {
    const end = eventEndParts(event({ start: "2026-09-07T00:00:00", duration: "P1D" }));
    expect(end).toEqual({ year: 2026, month: 9, day: 8, hour: 0, minute: 0, second: 0 });
  });

  it("returns the start when there is no duration", () => {
    const end = eventEndParts(event({ start: "2026-09-07T09:00:00" }));
    expect(end).toEqual({ year: 2026, month: 9, day: 7, hour: 9, minute: 0, second: 0 });
  });

  it("defaults an all-day event with no duration to one day", () => {
    const end = eventEndParts(event({ start: "2026-09-07T00:00:00", showWithoutTime: true }));
    expect(end).toEqual({ year: 2026, month: 9, day: 8, hour: 0, minute: 0, second: 0 });
  });

  it("returns null for an event with no start", () => {
    expect(eventEndParts(event({}))).toBeNull();
  });
});

describe("formatTimeRange", () => {
  it("formats a same-day timed range", () => {
    expect(formatTimeRange(event({ start: "2026-09-07T09:00:00", duration: "PT30M" }))).toBe(
      "09:00 – 09:30",
    );
  });

  it("formats a single all-day event", () => {
    expect(
      formatTimeRange(
        event({ start: "2026-09-07T00:00:00", showWithoutTime: true, duration: "P1D" }),
      ),
    ).toBe("All day");
  });

  it("formats an all-day event with no explicit duration as 'All day'", () => {
    // RFC 8984: a showWithoutTime event with no duration is one day — must not read "Sep 6 – Sep 7".
    expect(formatTimeRange(event({ start: "2026-09-07T00:00:00", showWithoutTime: true }))).toBe(
      "All day",
    );
  });

  it("formats a multi-day all-day event with inclusive end", () => {
    // P3D from Sep 7 spans Sep 7–9 inclusive (the end date is exclusive in JSCalendar).
    expect(
      formatTimeRange(
        event({ start: "2026-09-07T00:00:00", showWithoutTime: true, duration: "P3D" }),
      ),
    ).toBe("Sep 7 – Sep 9");
  });

  it("formats a timed range that crosses days", () => {
    expect(formatTimeRange(event({ start: "2026-09-07T23:00:00", duration: "PT2H" }))).toBe(
      "Sep 7 23:00 – Sep 8 01:00",
    );
  });

  it("returns empty for an event with no start", () => {
    expect(formatTimeRange(event({}))).toBe("");
  });
});

describe("dayKey / formatDayHeading", () => {
  it("keys by the start date", () => {
    expect(dayKey(event({ start: "2026-09-07T09:00:00" }))).toBe("2026-09-07");
    expect(dayKey(event({}))).toBe("");
  });

  it("formats a heading, adding the year only when it differs from now", () => {
    const now = new Date("2026-06-17T00:00:00");
    expect(formatDayHeading("2026-09-07", now)).toBe("Mon, Sep 7");
    expect(formatDayHeading("2027-01-01", now)).toBe("Fri, Jan 1, 2027");
  });
});

describe("eventDisplayTitle", () => {
  it("uses the title, else a placeholder", () => {
    expect(eventDisplayTitle(event({ title: "Standup" }))).toBe("Standup");
    expect(eventDisplayTitle(event({ title: "   " }))).toBe("(no title)");
    expect(eventDisplayTitle(event({}))).toBe("(no title)");
  });
});

describe("compareEvents / groupEventsByDay", () => {
  it("orders by start then title", () => {
    const a = event({ id: "a", start: "2026-09-07T09:00:00", title: "B" });
    const b = event({ id: "b", start: "2026-09-07T08:00:00", title: "Z" });
    const c = event({ id: "c", start: "2026-09-07T09:00:00", title: "A" });
    expect([a, b, c].sort(compareEvents).map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("orders same-minute events by their seconds, not by title", () => {
    const late = event({ id: "late", start: "2026-09-07T09:00:50", title: "AAA" });
    const early = event({ id: "early", start: "2026-09-07T09:00:10", title: "ZZZ" });
    expect([late, early].sort(compareEvents).map((e) => e.id)).toEqual(["early", "late"]);
  });

  it("groups events by day in chronological order, sorted within each day, dropping undated", () => {
    const now = new Date("2026-09-01T00:00:00");
    const groups = groupEventsByDay(
      [
        event({ id: "late", start: "2026-09-08T14:00:00", title: "Late" }),
        event({ id: "early", start: "2026-09-07T09:00:00", title: "Early" }),
        event({ id: "mid", start: "2026-09-07T11:00:00", title: "Mid" }),
        event({ id: "undated" }),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(["2026-09-07", "2026-09-08"]);
    expect(groups[0]?.heading).toBe("Mon, Sep 7");
    expect(groups[0]?.events.map((e) => e.id)).toEqual(["early", "mid"]);
    expect(groups[1]?.events.map((e) => e.id)).toEqual(["late"]);
  });
});

describe("compareCalendars", () => {
  it("orders default first, then by sortOrder, then name", () => {
    const def = cal({ id: "d", name: "Zeta", isDefault: true, sortOrder: 9 });
    const a = cal({ id: "a", name: "Work", sortOrder: 1 });
    const b = cal({ id: "b", name: "Personal", sortOrder: 0 });
    expect([a, def, b].sort(compareCalendars).map((c) => c.id)).toEqual(["d", "b", "a"]);
  });
});

describe("recurrenceSummary", () => {
  it("returns null when there is no rule", () => {
    expect(recurrenceSummary(undefined)).toBeNull();
    expect(recurrenceSummary({ frequency: "" })).toBeNull();
  });

  it("summarizes plain frequencies", () => {
    expect(recurrenceSummary({ frequency: "daily" })).toBe("Daily");
    expect(recurrenceSummary({ frequency: "weekly" })).toBe("Weekly");
    expect(recurrenceSummary({ frequency: "monthly" })).toBe("Monthly");
  });

  it("uses an interval", () => {
    expect(recurrenceSummary({ frequency: "weekly", interval: 2 })).toBe("Every 2 weeks");
  });

  it("names the weekday(s)", () => {
    expect(recurrenceSummary({ frequency: "weekly", byDay: [{ day: "mo" }, { day: "we" }] })).toBe(
      "Weekly on Monday, Wednesday",
    );
  });

  it("appends a count or an until", () => {
    expect(recurrenceSummary({ frequency: "daily", count: 10 })).toBe("Daily, 10 times");
    expect(recurrenceSummary({ frequency: "weekly", until: "2026-12-31T00:00:00" })).toBe(
      "Weekly, until Dec 31",
    );
  });

  it("degrades to a generic marker for an unknown frequency", () => {
    expect(recurrenceSummary({ frequency: "hourly" })).toBe("Repeats");
  });
});

describe("emptyEditableEvent", () => {
  it("seeds a default one-hour timed slot at the next top of the hour", () => {
    const now = new Date("2026-09-07T09:30:00"); // a local wall-clock instant
    const e = emptyEditableEvent(now);
    expect(e.title).toBe("");
    expect(e.allDay).toBe(false);
    expect(e.timeZone).toBe("");
    // Next top of the hour → 10:00, one hour long → 11:00 (datetime-local shape, no seconds).
    expect(e.start).toBe("2026-09-07T10:00");
    expect(e.end).toBe("2026-09-07T11:00");
    // The seeded default is already a VALID when (createEventError null) but needs a title to save.
    expect(createEventError(e)).toBeNull();
    expect(editableHasContent(e)).toBe(false);
  });
});

describe("editableHasContent / createEventError", () => {
  const base = emptyEditableEvent(new Date("2026-09-07T09:30:00"));

  it("requires both a non-blank title and a valid when", () => {
    expect(editableHasContent(base)).toBe(false); // no title
    expect(editableHasContent({ ...base, title: "   " })).toBe(false); // whitespace only
    expect(editableHasContent({ ...base, title: "Lunch" })).toBe(true);
    // A title but an invalid when (end before start) is not savable.
    expect(editableHasContent({ ...base, title: "Lunch", end: "2026-09-07T09:00" })).toBe(false);
  });

  it("flags an invalid when regardless of title", () => {
    expect(createEventError(base)).toBeNull();
    expect(createEventError({ ...base, end: "2026-09-07T09:00" })).toMatch(/end can't be before/i);
    expect(createEventError({ ...base, start: "" })).toMatch(/valid start/i);
  });
});

describe("createEventBody / createdEventFor", () => {
  const edits: EditableEvent = {
    ...emptyEditableEvent(new Date("2026-09-07T09:30:00")),
    title: "Standup",
    description: "Daily",
    location: "Room A",
    status: "confirmed",
  };

  it("builds a create body with @type, calendarIds, and the rebuilt editable props", () => {
    const body = createEventBody(edits, { b: true });
    expect(body["@type"]).toBe("Event");
    expect(body.calendarIds).toEqual({ b: true });
    expect(body.title).toBe("Standup");
    expect(body.description).toBe("Daily");
    expect(body.locations).toEqual({ l1: { "@type": "Location", name: "Room A" } });
    expect(body.status).toBe("confirmed");
    expect(body.start).toBe("2026-09-07T10:00:00");
    expect(body.duration).toBe("PT1H");
    // No id/uid (server assigns), and nothing for the absent recurrence/participants/keywords.
    expect(body.id).toBeUndefined();
    expect(body.uid).toBeUndefined();
    expect(body.recurrenceRule).toBeUndefined();
    expect(body.participants).toBeUndefined();
  });

  it("drops blank editable props from the body", () => {
    const body = createEventBody(
      { ...emptyEditableEvent(new Date("2026-09-07T09:30:00")), title: "Bare" },
      { b: true },
    );
    expect(body.title).toBe("Bare");
    expect(body.description).toBeUndefined();
    expect(body.locations).toBeUndefined();
    expect(body.status).toBeUndefined();
  });

  it("seeds a full local event under the server id for the optimistic write", () => {
    const seeded = createdEventFor("srv1", edits, { b: true });
    expect(seeded.id).toBe("srv1");
    expect(seeded["@type"]).toBe("Event");
    expect(seeded.calendarIds).toEqual({ b: true });
    expect(seeded.title).toBe("Standup");
    expect(seeded.start).toBe("2026-09-07T10:00:00");
    expect(seeded.duration).toBe("PT1H");
    // The seed parses as a placeable agenda row (same transform as the create body).
    expect(isAllDay(seeded)).toBe(false);
  });
});

describe("freshOccurrenceIdForBase", () => {
  it("returns the single freshly-appeared occurrence ending in the base id", () => {
    const before = new Set(["eaaaaax", "eaaaaay"]);
    // After a create of base "g": its occurrence "eaaaaag" is new and ends in "g".
    expect(freshOccurrenceIdForBase("g", ["eaaaaax", "eaaaaag", "eaaaaay"], before)).toBe(
      "eaaaaag",
    );
  });

  it("returns null when the new event is out of window (no fresh occurrence)", () => {
    const before = new Set(["eaaaaax"]);
    expect(freshOccurrenceIdForBase("g", ["eaaaaax"], before)).toBeNull();
  });

  it("excludes a pre-existing occurrence that coincidentally ends in the base id", () => {
    // "eaaaaag" already existed (an occurrence of some other base ending in "g") → not fresh → null.
    const before = new Set(["eaaaaag"]);
    expect(freshOccurrenceIdForBase("g", ["eaaaaag"], before)).toBeNull();
  });

  it("returns null on an ambiguous multi-match rather than guessing", () => {
    const before = new Set<string>();
    expect(freshOccurrenceIdForBase("g", ["eaaaaag", "baaaaag"], before)).toBeNull();
  });
});

describe("writableCalendars / defaultWritableCalendarId", () => {
  it("keeps only writable calendars, sorted, with the default first", () => {
    const def = cal({ id: "d", name: "Zeta", isDefault: true, sortOrder: 9 });
    const work = cal({ id: "w", name: "Work", sortOrder: 1 });
    const ro = cal({ id: "r", name: "Read only", myRights: readonlyRights });
    // mayWriteOwn alone is enough to be writable.
    const own = cal({
      id: "o",
      name: "Own",
      sortOrder: 2,
      myRights: { ...readonlyRights, mayWriteOwn: true },
    });
    const writable = writableCalendars({ r: ro, w: work, d: def, o: own });
    expect(writable.map((c) => c.id)).toEqual(["d", "w", "o"]);
    expect(defaultWritableCalendarId(writable)).toBe("d");
  });

  it("falls back to the first writable when none is the default, and null when empty", () => {
    const a = cal({ id: "a", name: "Alpha", sortOrder: 0 });
    expect(defaultWritableCalendarId(writableCalendars({ a }))).toBe("a");
    expect(
      defaultWritableCalendarId(writableCalendars({ r: cal({ myRights: readonlyRights }) })),
    ).toBe(null);
  });
});
