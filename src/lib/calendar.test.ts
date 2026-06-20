import { describe, expect, it } from "vitest";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import {
  compareCalendars,
  compareEvents,
  createdEventFor,
  createEventBody,
  createEventError,
  createSeedDate,
  dateTimeInput,
  dayKey,
  defaultWritableCalendarId,
  displayEndParts,
  displayStartParts,
  dragCreateSeed,
  dropToSourceStart,
  type EditableEvent,
  editableHasContent,
  emptyEditableEvent,
  eventAccessibleName,
  eventCoversDays,
  eventDayPlacement,
  eventDisplayTitle,
  eventEndDayKey,
  eventEndParts,
  formatDayHeading,
  formatTimeRange,
  freshOccurrenceIdForBase,
  groupEventsByDay,
  isAllDay,
  isRecurring,
  LOCAL_ZONE,
  layoutAllDayLane,
  layoutMonth,
  monthGridWeeks,
  nowIndicatorOffset,
  packDayColumns,
  parseDateParts,
  parseDuration,
  partsAddMs,
  partsUtcMs,
  pointerToGrid,
  rangeLabel,
  recurrenceSummary,
  resizeGeometry,
  snapMinutes,
  stepAnchor,
  todayAnchor,
  visibleRange,
  weekDays,
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

// These helpers build the query window / nav from LOCAL dates, so the expectations are computed the
// same way (local Date construction) to stay tz-independent: both sides shift by the runner's offset
// identically. June 2026: the 1st is a Monday, the 14th/21st are Sundays, the 17th is a Wednesday.
describe("visibleRange", () => {
  it("day mode = the single anchor day (exclusive next-midnight end)", () => {
    expect(visibleRange("day", new Date(2026, 5, 17))).toEqual({
      after: new Date(2026, 5, 17).toISOString(),
      before: new Date(2026, 5, 18).toISOString(),
    });
  });

  it("week mode = the Sun…Sat week containing the anchor", () => {
    // Wed Jun 17 → week starts Sun Jun 14, exclusive end Sun Jun 21.
    expect(visibleRange("week", new Date(2026, 5, 17))).toEqual({
      after: new Date(2026, 5, 14).toISOString(),
      before: new Date(2026, 5, 21).toISOString(),
    });
    // A Sunday anchor is the week start (not pulled back a week).
    expect(visibleRange("week", new Date(2026, 5, 14)).after).toBe(
      new Date(2026, 5, 14).toISOString(),
    );
  });

  it("agenda mode = anchor → anchor + 56 days", () => {
    expect(visibleRange("agenda", new Date(2026, 5, 17))).toEqual({
      after: new Date(2026, 5, 17).toISOString(),
      before: new Date(2026, 7, 12).toISOString(), // Jun 17 + 56d = Aug 12
    });
  });

  it("month mode pads the month out to whole weeks (Sun-start, exclusive end)", () => {
    // June 2026: 1st=Mon → grid starts Sun May 31; last=Tue Jun 30 → its week's Sun is Jun 28, so the
    // exclusive end is Jul 5. A 5-row (35-day) grid. The anchor's day-of-month is irrelevant.
    const range = visibleRange("month", new Date(2026, 5, 17));
    expect(range).toEqual({
      after: new Date(2026, 4, 31).toISOString(),
      before: new Date(2026, 6, 5).toISOString(),
    });
    const spanDays = Math.round(
      (new Date(range.before).getTime() - new Date(range.after).getTime()) / 86_400_000,
    );
    expect(spanDays).toBe(35);
    expect(spanDays % 7).toBe(0); // always whole weeks
    // Any day in the month yields the same month window.
    expect(visibleRange("month", new Date(2026, 5, 1))).toEqual(range);
    expect(visibleRange("month", new Date(2026, 5, 30))).toEqual(range);
  });
});

describe("stepAnchor", () => {
  it("steps day/week/agenda by their window length", () => {
    expect(stepAnchor("day", new Date(2026, 5, 17), 1)).toEqual(new Date(2026, 5, 18));
    expect(stepAnchor("day", new Date(2026, 5, 17), -1)).toEqual(new Date(2026, 5, 16));
    expect(stepAnchor("week", new Date(2026, 5, 17), 1)).toEqual(new Date(2026, 5, 24));
    expect(stepAnchor("week", new Date(2026, 5, 17), -1)).toEqual(new Date(2026, 5, 10));
    expect(stepAnchor("agenda", new Date(2026, 5, 17), 1)).toEqual(new Date(2026, 7, 12));
  });

  it("steps month-to-month off the 1st so a 31st never skips a short month", () => {
    // The overflow trap: Jan 31 + 1 month via setMonth alone is Mar 3 (skips Feb). Pinning to the 1st
    // first lands on Feb 1.
    const next = stepAnchor("month", new Date(2026, 0, 31), 1);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(1); // February, not March
    // Year rollover both directions.
    expect(stepAnchor("month", new Date(2026, 11, 15), 1).getMonth()).toBe(0); // Dec → Jan
    expect(stepAnchor("month", new Date(2026, 11, 15), 1).getFullYear()).toBe(2027);
    expect(stepAnchor("month", new Date(2026, 0, 15), -1).getFullYear()).toBe(2025); // Jan → Dec
  });
});

describe("todayAnchor / rangeLabel", () => {
  it("todayAnchor is the local midnight of now", () => {
    expect(todayAnchor(new Date(2026, 5, 17, 14, 30))).toEqual(new Date(2026, 5, 17));
  });

  it("labels each view window", () => {
    const now = new Date(2026, 5, 17);
    expect(rangeLabel("month", new Date(2026, 5, 17), now)).toBe("June 2026");
    expect(rangeLabel("day", new Date(2026, 5, 17), now)).toBe("Wed, Jun 17");
    // Sun-start week of Jun 17 = Jun 14 – 20 (same month → no repeated month on the right).
    expect(rangeLabel("week", new Date(2026, 5, 17), now)).toBe("Jun 14 – 20");
    // Agenda spans Jun 17 → Aug 11 (cross-month label).
    expect(rangeLabel("agenda", new Date(2026, 5, 17), now)).toBe("Jun 17 – Aug 11");
  });

  it("appends the year when the window isn't in the current year", () => {
    const now = new Date(2026, 5, 17);
    expect(rangeLabel("day", new Date(2027, 0, 5), now)).toBe("Tue, Jan 5, 2027");
  });

  it("labels a cross-year span with both years", () => {
    const now = new Date(2026, 11, 31); // current year 2026
    // A week straddling the year boundary: Sun Dec 27 2026 – Sat Jan 2 2027.
    expect(rangeLabel("week", new Date(2026, 11, 30), now)).toBe("Dec 27, 2026 – Jan 2, 2027");
  });
});

describe("createSeedDate", () => {
  const now = new Date(2026, 5, 17, 14, 30); // Wed Jun 17 2026, 14:30

  it("returns now when today is in the visible window", () => {
    // Agenda anchored today, and month anchored on this month, both contain today → seed at now.
    expect(createSeedDate("agenda", todayAnchor(now), now)).toEqual(now);
    expect(createSeedDate("month", new Date(2026, 5, 1), now)).toEqual(now);
  });

  it("seeds the anchor's day (at now's time-of-day) when today is out of the window", () => {
    // Agenda navigated ~7 months out: today isn't in [anchor, anchor+56d) → seed on the anchor day.
    const farAnchor = new Date(2027, 0, 10); // Jan 10 2027
    expect(createSeedDate("agenda", farAnchor, now)).toEqual(new Date(2027, 0, 10, 14, 30));
    // Month navigated to a different month likewise.
    expect(createSeedDate("month", new Date(2027, 2, 1), now)).toEqual(
      new Date(2027, 2, 1, 14, 30),
    );
  });
});

describe("monthGridWeeks", () => {
  const now = new Date(2026, 5, 17); // Wed Jun 17 2026

  it("pads the month out to whole Sun-start weeks, tagging in/out-of-month + today", () => {
    // June 2026: 1st = Mon → grid starts Sun May 31; last = Tue Jun 30 → week ends Sat Jul 4. 5 rows.
    const weeks = monthGridWeeks(new Date(2026, 5, 1), now);
    expect(weeks.length).toBe(5);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // First cell = the leading adjacent-month Sunday.
    expect(weeks[0]?.[0]).toMatchObject({ key: "2026-05-31", day: 31, inMonth: false });
    // June 1 is the next cell, in-month.
    expect(weeks[0]?.[1]).toMatchObject({ key: "2026-06-01", day: 1, inMonth: true });
    // Last cell = the trailing adjacent-month day.
    expect(weeks[4]?.[6]).toMatchObject({ key: "2026-07-04", day: 4, inMonth: false });
    // Today (Jun 17, Wed) lands in week index 2, column 3 (Sun14 Mon15 Tue16 Wed17), flagged once.
    expect(weeks[2]?.[3]).toMatchObject({ key: "2026-06-17", isToday: true });
    expect(weeks.flat().filter((c) => c.isToday).length).toBe(1);
  });

  it("yields a 4-row grid for a Feb that fills exactly four weeks", () => {
    // Feb 2026: 1st = Sun, 28 days (non-leap) → exactly 4 weeks, no padding.
    const weeks = monthGridWeeks(new Date(2026, 1, 10), now);
    expect(weeks.length).toBe(4);
    expect(weeks[0]?.[0]?.key).toBe("2026-02-01");
    expect(weeks[3]?.[6]?.key).toBe("2026-02-28");
    expect(weeks.flat().every((c) => c.inMonth)).toBe(true);
  });

  it("includes Feb 29 in a leap year", () => {
    const weeks = monthGridWeeks(new Date(2024, 1, 15), now);
    const leapDay = weeks.flat().find((c) => c.key === "2024-02-29");
    expect(leapDay).toMatchObject({ day: 29, inMonth: true });
  });

  it("yields a 6-row grid for a long month starting late in the week", () => {
    // May 2026: 1st = Fri, 31 days, 31st = Sun → 6 rows (Apr 26 … Jun 6).
    const weeks = monthGridWeeks(new Date(2026, 4, 1), now);
    expect(weeks.length).toBe(6);
    expect(weeks[0]?.[0]?.key).toBe("2026-04-26");
    expect(weeks[5]?.[6]?.key).toBe("2026-06-06");
  });

  it("handles the year boundary, dimming next-year trailing days", () => {
    // Dec 2026: 1st = Tue → grid starts Sun Nov 29; last = Thu Dec 31 → week ends Sat Jan 2 2027.
    const weeks = monthGridWeeks(new Date(2026, 11, 1), now);
    expect(weeks[0]?.[0]?.key).toBe("2026-11-29");
    const jan2 = weeks.flat().find((c) => c.key === "2027-01-02");
    expect(jan2).toMatchObject({ day: 2, inMonth: false }); // next year → not in-month
  });
});

describe("eventCoversDays", () => {
  it("returns one key for a single-day timed event", () => {
    expect(eventCoversDays(event({ start: "2026-06-17T09:00:00", duration: "PT1H" }))).toEqual([
      "2026-06-17",
    ]);
  });

  it("returns one key for a single all-day event (exclusive end steps back)", () => {
    expect(
      eventCoversDays(
        event({ start: "2026-06-17T00:00:00", duration: "P1D", showWithoutTime: true }),
      ),
    ).toEqual(["2026-06-17"]);
  });

  it("returns the contiguous range for a multi-day all-day event", () => {
    expect(
      eventCoversDays(
        event({ start: "2026-09-07T00:00:00", duration: "P3D", showWithoutTime: true }),
      ),
    ).toEqual(["2026-09-07", "2026-09-08", "2026-09-09"]);
  });

  it("covers each day a timed multi-day event touches", () => {
    expect(eventCoversDays(event({ start: "2026-09-07T14:00:00", duration: "P2D" }))).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
    ]);
  });

  it("excludes the final day when a timed event ends exactly at midnight", () => {
    // 22:00 + 2h = next day 00:00 — occupies no time on that day, so only the start day is covered.
    expect(eventCoversDays(event({ start: "2026-06-17T22:00:00", duration: "PT2H" }))).toEqual([
      "2026-06-17",
    ]);
    // 23:00 + 2h = next day 01:00 — genuinely spills into the next day.
    expect(eventCoversDays(event({ start: "2026-06-17T23:00:00", duration: "PT2H" }))).toEqual([
      "2026-06-17",
      "2026-06-18",
    ]);
  });

  it("is empty when the start is unparseable", () => {
    expect(eventCoversDays(event({ start: undefined }))).toEqual([]);
  });
});

describe("layoutMonth", () => {
  const weeks = monthGridWeeks(new Date(2026, 5, 1)); // June 2026, 5 rows; week[2] = Sun14…Sat20

  it("places a single-day chip in its day's column", () => {
    const e = event({ id: "chip", start: "2026-06-17T09:00:00", duration: "PT1H" });
    const layout = layoutMonth([e], weeks);
    const seg = layout[2]?.segments.find((s) => s.event.id === "chip");
    expect(seg).toMatchObject({ startCol: 3, endCol: 3, lane: 0, isSpan: false });
    expect(seg?.continuesBefore).toBe(false);
    expect(seg?.continuesAfter).toBe(false);
  });

  it("draws a multi-day all-day event as a bar spanning its columns", () => {
    // Jun 16–18 inclusive (all-day P3D) → cols 2–4 of week[2], a bar.
    const e = event({
      id: "bar",
      start: "2026-06-16T00:00:00",
      duration: "P3D",
      showWithoutTime: true,
    });
    const seg = layoutMonth([e], weeks)[2]?.segments.find((s) => s.event.id === "bar");
    expect(seg).toMatchObject({ startCol: 2, endCol: 4, isSpan: true });
  });

  it("splits a span crossing a week boundary into per-row segments with open edges", () => {
    // Fri Jun 19 → Mon Jun 22 (all-day): week[2] cols 5–6 (continuesAfter), week[3] cols 0–1
    // (continuesBefore).
    const e = event({
      id: "split",
      start: "2026-06-19T00:00:00",
      duration: "P4D",
      showWithoutTime: true,
    });
    const layout = layoutMonth([e], weeks);
    expect(layout[2]?.segments.find((s) => s.event.id === "split")).toMatchObject({
      startCol: 5,
      endCol: 6,
      continuesBefore: false,
      continuesAfter: true,
    });
    expect(layout[3]?.segments.find((s) => s.event.id === "split")).toMatchObject({
      startCol: 0,
      endCol: 1,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it("clips a span starting before the grid window to the visible columns", () => {
    // May 28 → Jun 2 (all-day): week[0] is May31…Jun6, so cols 0–2, continuesBefore (started May 28).
    const e = event({
      id: "early",
      start: "2026-05-28T00:00:00",
      duration: "P6D",
      showWithoutTime: true,
    });
    const seg = layoutMonth([e], weeks)[0]?.segments.find((s) => s.event.id === "early");
    expect(seg).toMatchObject({ startCol: 0, endCol: 2, continuesBefore: true });
  });

  it("packs overlapping events into separate lanes, bars before chips", () => {
    const bar = event({
      id: "bar",
      start: "2026-06-16T00:00:00",
      duration: "P3D",
      showWithoutTime: true,
    }); // cols 2–4
    const chip = event({ id: "chip", start: "2026-06-17T09:00:00", duration: "PT1H" }); // col 3
    const segs = layoutMonth([chip, bar], weeks)[2]?.segments ?? [];
    expect(segs.find((s) => s.event.id === "bar")?.lane).toBe(0);
    expect(segs.find((s) => s.event.id === "chip")?.lane).toBe(1); // overlaps the bar → next lane
  });

  it("keeps non-overlapping (exact-touch) spans in the same lane", () => {
    const a = event({
      id: "a",
      start: "2026-06-15T00:00:00",
      duration: "P2D",
      showWithoutTime: true,
    }); // cols 1–2
    const b = event({
      id: "b",
      start: "2026-06-17T00:00:00",
      duration: "P2D",
      showWithoutTime: true,
    }); // cols 3–4 (touches a's right edge but doesn't overlap)
    const segs = layoutMonth([a, b], weeks)[2]?.segments ?? [];
    expect(segs.find((s) => s.event.id === "a")?.lane).toBe(0);
    expect(segs.find((s) => s.event.id === "b")?.lane).toBe(0);
  });

  it("collapses lanes past the visible cap into per-column overflow", () => {
    const bar = event({
      id: "bar",
      start: "2026-06-16T00:00:00",
      duration: "P3D",
      showWithoutTime: true,
    }); // lane 0, cols 2–4
    const chip = event({ id: "chip", start: "2026-06-17T09:00:00", duration: "PT1H" }); // lane 1, col 3
    const layout = layoutMonth([chip, bar], weeks, 1); // only 1 visible lane
    expect(layout[2]?.segments.map((s) => s.event.id)).toEqual(["bar"]);
    // The hidden chip is counted as overflow on its column (3) only.
    expect(layout[2]?.overflow).toEqual([0, 0, 0, 1, 0, 0, 0]);
  });
});

describe("weekDays", () => {
  it("returns the Sun-start 7-day week containing the anchor", () => {
    // Wed Jun 17 2026 → Sun Jun 14 … Sat Jun 20.
    expect(weekDays(new Date(2026, 5, 17), 7)).toEqual([
      "2026-06-14",
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
    ]);
  });

  it("returns just the anchor's own day for count 1", () => {
    expect(weekDays(new Date(2026, 5, 17), 1)).toEqual(["2026-06-17"]);
  });

  it("crosses a month boundary within the week", () => {
    // Tue Jun 30 2026 → the week Sun Jun 28 … Sat Jul 4.
    expect(weekDays(new Date(2026, 5, 30), 7)).toEqual([
      "2026-06-28",
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ]);
  });
});

describe("eventDayPlacement", () => {
  it("places a timed event by start offset + duration height", () => {
    const e = event({ start: "2026-06-17T09:00:00", duration: "PT1H" });
    expect(eventDayPlacement(e, "2026-06-17")).toMatchObject({ top: 540, height: 60 });
  });

  it("returns null for an all-day event (it belongs to the all-day lane)", () => {
    const e = event({ start: "2026-06-17T00:00:00", duration: "P1D", showWithoutTime: true });
    expect(eventDayPlacement(e, "2026-06-17")).toBeNull();
  });

  it("returns null when the event doesn't fall on the day", () => {
    const e = event({ start: "2026-06-17T09:00:00", duration: "PT1H" });
    expect(eventDayPlacement(e, "2026-06-18")).toBeNull();
  });

  it("clamps a midnight-crossing event to one block per covered day", () => {
    const e = event({ start: "2026-06-17T23:00:00", duration: "PT2H" }); // 23:00 → 01:00 next day
    expect(eventDayPlacement(e, "2026-06-17")).toMatchObject({ top: 1380, height: 60 });
    expect(eventDayPlacement(e, "2026-06-18")).toMatchObject({ top: 0, height: 60 });
  });

  it("does not render on the next day for an event ending exactly at midnight", () => {
    const e = event({ start: "2026-06-17T23:00:00", duration: "PT1H" }); // ends 2026-06-18T00:00
    expect(eventDayPlacement(e, "2026-06-17")).toMatchObject({ top: 1380, height: 60 });
    expect(eventDayPlacement(e, "2026-06-18")).toBeNull(); // half-open: occupies no time on the 18th
  });

  it("keeps a zero-duration event with height 0 on its day", () => {
    const e = event({ start: "2026-06-17T09:00:00" }); // no duration → end = start
    expect(eventDayPlacement(e, "2026-06-17")).toMatchObject({ top: 540, height: 0 });
  });
});

describe("packDayColumns", () => {
  const place = (id: string, top: number, height: number) => ({
    event: event({ id, start: "2026-06-17T00:00:00" }),
    top,
    height,
  });

  it("gives non-overlapping (exact-touch) events the same full-width column", () => {
    const packed = packDayColumns([place("a", 0, 60), place("b", 60, 60)]);
    expect(packed.map((p) => [p.event.id, p.column, p.columns])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
    ]);
  });

  it("splits two overlapping events into side-by-side sub-columns", () => {
    const packed = packDayColumns([place("a", 0, 120), place("b", 60, 60)]);
    const byId = Object.fromEntries(packed.map((p) => [p.event.id, p]));
    expect(byId.a).toMatchObject({ column: 0, columns: 2 });
    expect(byId.b).toMatchObject({ column: 1, columns: 2 });
  });

  it("reuses a freed column in a three-way overlap (peak concurrency 2)", () => {
    // A 0–120, B 60–180, C 120–240: A&B overlap, B&C overlap, A&C exact-touch (share a column).
    const packed = packDayColumns([place("a", 0, 120), place("b", 60, 120), place("c", 120, 120)]);
    const byId = Object.fromEntries(packed.map((p) => [p.event.id, p]));
    expect(byId.a).toMatchObject({ column: 0, columns: 2 });
    expect(byId.b).toMatchObject({ column: 1, columns: 2 });
    expect(byId.c).toMatchObject({ column: 0, columns: 2 });
  });

  it("orders same-start events deterministically by compareEvents", () => {
    // Same start + height → tie broken by title (compareEvents): "Alpha" before "Zeta".
    const packed = packDayColumns([
      {
        event: event({ id: "z", title: "Zeta", start: "2026-06-17T09:00:00" }),
        top: 540,
        height: 60,
      },
      {
        event: event({ id: "a", title: "Alpha", start: "2026-06-17T09:00:00" }),
        top: 540,
        height: 60,
      },
    ]);
    const byId = Object.fromEntries(packed.map((p) => [p.event.id, p]));
    expect(byId.a?.column).toBe(0); // Alpha takes the leftmost column
    expect(byId.z?.column).toBe(1);
  });

  it("packs against minHeight so short non-overlapping blocks don't visually collide", () => {
    // a: 09:00–09:05, b: 09:10–09:15 — disjoint in TIME, but each floors to 24min when rendered.
    // With minHeight 24 their effective spans (09:00–09:24, 09:10–09:34) overlap → side-by-side.
    const both = [place("a", 540, 5), place("b", 550, 5)];
    const exact = packDayColumns(both); // no floor → same full-width column
    expect(Object.fromEntries(exact.map((p) => [p.event.id, p.columns]))).toEqual({ a: 1, b: 1 });
    const floored = packDayColumns(both, 24);
    const byId = Object.fromEntries(floored.map((p) => [p.event.id, p]));
    expect(byId.a).toMatchObject({ column: 0, columns: 2 });
    expect(byId.b).toMatchObject({ column: 1, columns: 2 });
    // The OUTPUT keeps the true heights (the renderer applies the same floor).
    expect(byId.a?.height).toBe(5);
  });

  it("tiles two zero-duration events at the same instant side-by-side under minHeight", () => {
    const packed = packDayColumns([place("a", 540, 0), place("b", 540, 0)], 24);
    expect(packed.map((p) => p.columns)).toEqual([2, 2]);
    expect(new Set(packed.map((p) => p.column))).toEqual(new Set([0, 1]));
  });
});

describe("layoutAllDayLane", () => {
  const week = [
    "2026-06-14",
    "2026-06-15",
    "2026-06-16",
    "2026-06-17",
    "2026-06-18",
    "2026-06-19",
    "2026-06-20",
  ];

  it("includes only all-day events (timed events go to the time grid)", () => {
    const allDay = event({
      id: "ad",
      start: "2026-06-16T00:00:00",
      duration: "P1D",
      showWithoutTime: true,
    });
    const timed = event({ id: "t", start: "2026-06-16T09:00:00", duration: "PT1H" });
    const segs = layoutAllDayLane([allDay, timed], week);
    expect(segs.map((s) => s.event.id)).toEqual(["ad"]);
    expect(segs[0]).toMatchObject({ startCol: 2, endCol: 2, lane: 0 });
  });

  it("clips a span starting before the window and flags the open edge", () => {
    // Jun 12 → Jun 16 (all-day P5D): clipped to cols 0–2, continuesBefore (started before Sun Jun 14).
    const e = event({
      id: "s",
      start: "2026-06-12T00:00:00",
      duration: "P5D",
      showWithoutTime: true,
    });
    expect(layoutAllDayLane([e], week)[0]).toMatchObject({
      startCol: 0,
      endCol: 2,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it("stacks overlapping bars into separate lanes", () => {
    const a = event({
      id: "a",
      start: "2026-06-15T00:00:00",
      duration: "P3D",
      showWithoutTime: true,
    }); // 15–17
    const b = event({
      id: "b",
      start: "2026-06-16T00:00:00",
      duration: "P2D",
      showWithoutTime: true,
    }); // 16–17
    const segs = layoutAllDayLane([a, b], week);
    expect(segs.find((s) => s.event.id === "a")?.lane).toBe(0);
    expect(segs.find((s) => s.event.id === "b")?.lane).toBe(1);
  });

  it("clips a multi-day span to a single-day (day-view) window", () => {
    const e = event({
      id: "s",
      start: "2026-06-16T00:00:00",
      duration: "P3D",
      showWithoutTime: true,
    });
    expect(layoutAllDayLane([e], ["2026-06-17"])[0]).toMatchObject({
      startCol: 0,
      endCol: 0,
      continuesBefore: true,
      continuesAfter: true,
    });
  });
});

describe("nowIndicatorOffset", () => {
  it("returns minutes-into-day on the matching local day", () => {
    expect(nowIndicatorOffset(new Date(2026, 5, 17, 9, 30), "2026-06-17")).toBe(570);
  });

  it("returns null on any other day", () => {
    expect(nowIndicatorOffset(new Date(2026, 5, 17, 9, 30), "2026-06-18")).toBeNull();
  });
});

describe("eventAccessibleName", () => {
  it("names the event by the passed column day, not its own start day", () => {
    // A midnight-crossing block on the SECOND day must announce that day, not the event's start day.
    // (toContain to stay robust to formatDayHeading's year suffix when run outside 2026.)
    const e = event({ title: "Night shift", start: "2026-06-17T23:00:00", duration: "PT2H" });
    const onDay2 = eventAccessibleName(e, "2026-06-18");
    expect(onDay2).toContain("Night shift");
    expect(onDay2).toContain("Thu, Jun 18"); // the column's day, not the start day (Wed Jun 17)
    expect(onDay2).toContain("Jun 17 23:00 – Jun 18 01:00");
    expect(eventAccessibleName(e, "2026-06-17")).toContain("Wed, Jun 17");
  });

  it("falls back to the placeholder title and omits an empty range", () => {
    const name = eventAccessibleName(event({ title: "" }), "2026-06-17");
    expect(name).toContain("(no title)");
    expect(name).toContain("Wed, Jun 17");
    expect(name).not.toContain(" – "); // no range part for a startless event
  });
});

describe("viewer-tz display conversion", () => {
  // Expected viewer-zone parts of a UTC instant, derived from the SAME Date API the conversion uses,
  // so these assertions hold regardless of the test runner's local zone (Windows dev / Linux CI).
  function localParts(utc: string) {
    const d = new Date(utc);
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
    };
  }
  function localKey(utc: string) {
    const p = localParts(utc);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }

  // A timed event in America/New_York at 22:00 local on Jul 1, whose absolute instant the server
  // computed as 02:00Z Jul 2 — i.e. it crosses midnight when viewed west of NY (and differs from the
  // literal wall-clock in essentially every zone, so the day-shift assertions are meaningful anywhere).
  const tzEvent = event({
    title: "NY meeting",
    start: "2026-07-01T22:00:00",
    timeZone: "America/New_York",
    duration: "PT1H",
    utcStart: "2026-07-02T02:00:00Z",
    utcEnd: "2026-07-02T03:00:00Z",
  });

  it("converts a timed tz-bearing event's start/end to the viewer's zone via utcStart/utcEnd", () => {
    // Equality with the local rendering of the instant proves conversion uses utcStart/utcEnd, and is
    // zone-independent (derived from the same Date API). We deliberately do NOT also assert it differs
    // from the literal source-zone start — that holds only when the runner's zone != America/New_York,
    // which would make the test flaky on an Eastern-US machine.
    expect(displayStartParts(tzEvent)).toEqual(localParts("2026-07-02T02:00:00Z"));
    expect(displayEndParts(tzEvent)).toEqual(localParts("2026-07-02T03:00:00Z"));
  });

  it("buckets and places a converted event on its viewer-zone day, not its source-zone day", () => {
    expect(dayKey(tzEvent)).toBe(localKey("2026-07-02T02:00:00Z"));
    // eventDayPlacement on the converted day column: top = viewer-zone minutes-from-midnight.
    const p = localParts("2026-07-02T02:00:00Z");
    const placement = eventDayPlacement(tzEvent, dayKey(tzEvent));
    expect(placement?.top).toBe(p.hour * 60 + p.minute);
    expect(placement?.height).toBe(60);
  });

  it("renders a floating event (timeZone null) at face value, NOT via its stamped utcStart", () => {
    // Stalwart stamps a floating literal time with Z (09:00 → 09:00:00Z) — meaningless as an instant;
    // a floating event must show 09:00 in any zone.
    const floating = event({
      start: "2026-07-01T09:00:00",
      timeZone: null,
      duration: "PT1H",
      utcStart: "2026-07-01T09:00:00Z",
      utcEnd: "2026-07-01T10:00:00Z",
    });
    expect(displayStartParts(floating)).toEqual(parseDateParts("2026-07-01T09:00:00"));
    expect(dayKey(floating)).toBe("2026-07-01");
    expect(formatTimeRange(floating)).toBe("09:00 – 10:00");
  });

  it("renders an all-day event at face value (date-based, never converted)", () => {
    const allDay = event({
      start: "2026-07-01T00:00:00",
      showWithoutTime: true,
      duration: "P1D",
      timeZone: null,
      utcStart: "2026-07-01T00:00:00Z",
    });
    expect(displayStartParts(allDay)).toEqual(parseDateParts("2026-07-01T00:00:00"));
    expect(dayKey(allDay)).toBe("2026-07-01");
    expect(eventCoversDays(allDay)).toEqual(["2026-07-01"]);
  });

  it("falls back to the literal start when utcStart is absent (older server / unrequested)", () => {
    const noUtc = event({
      start: "2026-07-01T22:00:00",
      timeZone: "America/New_York",
      duration: "PT1H",
    });
    expect(displayStartParts(noUtc)).toEqual(parseDateParts("2026-07-01T22:00:00"));
    expect(dayKey(noUtc)).toBe("2026-07-01");
  });

  it("converts ALL-OR-NOTHING: a present utcStart with an absent utcEnd keeps BOTH at face value", () => {
    // Guards against a mixed frame — a converted start paired with a literal source-zone end would
    // render a backwards/oversized range. With only one instant present the event must not convert.
    const partial = event({
      start: "2026-07-01T22:00:00",
      timeZone: "America/New_York",
      duration: "PT1H",
      utcStart: "2026-07-02T02:00:00Z",
      // utcEnd deliberately absent
    });
    expect(displayStartParts(partial)).toEqual(parseDateParts("2026-07-01T22:00:00"));
    expect(displayEndParts(partial)).toEqual(parseDateParts("2026-07-01T23:00:00"));
    expect(formatTimeRange(partial)).toBe("22:00 – 23:00"); // one frame, forward range
  });

  it("treats an UNPARSEABLE instant the same as an absent one (both endpoints stay literal)", () => {
    // The all-or-nothing gate is on PARSEABILITY, not just presence — a present-but-garbage utcEnd
    // must NOT let the start convert while the end falls back (the same mixed-frame hazard).
    const badEnd = event({
      start: "2026-07-01T22:00:00",
      timeZone: "America/New_York",
      duration: "PT1H",
      utcStart: "2026-07-02T02:00:00Z",
      utcEnd: "not-a-date",
    });
    expect(displayStartParts(badEnd)).toEqual(parseDateParts("2026-07-01T22:00:00"));
    expect(displayEndParts(badEnd)).toEqual(parseDateParts("2026-07-01T23:00:00"));
    expect(formatTimeRange(badEnd)).toBe("22:00 – 23:00");
  });

  it("does NOT convert a designator-less instant (no Z/offset → locally misinterpreted)", () => {
    // "2026-07-02T02:00:00" without a Z would be parsed by Date.parse in the viewer's local zone, so
    // the gate must reject it and fall back to the literal source-zone start, not "convert" a
    // misinterpreted instant.
    const noZ = event({
      start: "2026-07-01T22:00:00",
      timeZone: "America/New_York",
      duration: "PT1H",
      utcStart: "2026-07-02T02:00:00",
      utcEnd: "2026-07-02T03:00:00",
    });
    expect(displayStartParts(noZ)).toEqual(parseDateParts("2026-07-01T22:00:00"));
    expect(displayEndParts(noZ)).toEqual(parseDateParts("2026-07-01T23:00:00"));
  });

  it("orders events by their DISPLAYED instant (a converted earlier time sorts first)", () => {
    // Floating 10:00 vs a tz event converting to a viewer-local time before it. Build the tz event so
    // its utcStart is one hour before the floating event's local 10:00 in the runner's own zone.
    const floatTen = event({ id: "float", title: "Floating 10am", start: "2026-07-01T10:00:00" });
    // Pick a utc instant that is 09:00 local in the runner's zone on the same day as the floating event.
    const targetLocal = new Date(2026, 6, 1, 9, 0, 0); // Jul 1 09:00 local
    const tzNine = event({
      id: "tz",
      title: "Converted 9am",
      start: "2026-07-01T13:00:00",
      timeZone: "America/New_York",
      utcStart: targetLocal.toISOString(),
      utcEnd: new Date(2026, 6, 1, 9, 30, 0).toISOString(),
      duration: "PT30M",
    });
    expect([floatTen, tzNine].sort(compareEvents).map((e) => e.id)).toEqual(["tz", "float"]);
  });
});

describe("viewer-tz selectable display zone (Branch 2)", () => {
  // FIXED-OFFSET zones (POSIX `Etc/GMT`, sign INVERTED: Etc/GMT+4 = UTC−4, Etc/GMT-9 = UTC+9). Using
  // fixed offsets — not America/New_York / Asia/Tokyo — keeps these assertions independent of tzdb/DST
  // legislation (offsets that can change retroactively), so a tzdata update can't break unrelated CI.
  // WEST = UTC−4, EAST = UTC+9: the same UTC instant renders on different days/times in each, so every
  // assertion is a concrete, machine-independent value. The DST-transition test below DELIBERATELY uses
  // a real DST zone (America/New_York) — that's the one place a fixed offset can't exercise.
  const WEST = "Etc/GMT+4"; // UTC−4
  const EAST = "Etc/GMT-9"; // UTC+9

  // A timed event whose server instant is 2026-07-02T02:00:00Z (1h long): 22:00 Jul 1 in WEST (UTC−4),
  // 11:00 Jul 2 in EAST (UTC+9) — it crosses the date line between the two zones.
  const tzEvent = event({
    title: "Cross-zone meeting",
    start: "2026-07-01T22:00:00",
    timeZone: WEST,
    duration: "PT1H",
    utcStart: "2026-07-02T02:00:00Z",
    utcEnd: "2026-07-02T03:00:00Z",
  });

  it("projects the same instant into different zones (start/end parts)", () => {
    expect(displayStartParts(tzEvent, WEST)).toEqual(parseDateParts("2026-07-01T22:00:00"));
    expect(displayEndParts(tzEvent, WEST)).toEqual(parseDateParts("2026-07-01T23:00:00"));
    expect(displayStartParts(tzEvent, EAST)).toEqual(parseDateParts("2026-07-02T11:00:00"));
    expect(displayEndParts(tzEvent, EAST)).toEqual(parseDateParts("2026-07-02T12:00:00"));
  });

  it("buckets, places, and labels a tz event in the selected zone", () => {
    expect(dayKey(tzEvent, WEST)).toBe("2026-07-01");
    expect(dayKey(tzEvent, EAST)).toBe("2026-07-02");
    expect(formatTimeRange(tzEvent, WEST)).toBe("22:00 – 23:00");
    expect(formatTimeRange(tzEvent, EAST)).toBe("11:00 – 12:00");
    expect(eventDayPlacement(tzEvent, "2026-07-01", WEST)).toMatchObject({
      top: 22 * 60,
      height: 60,
    });
    expect(eventDayPlacement(tzEvent, "2026-07-02", EAST)).toMatchObject({
      top: 11 * 60,
      height: 60,
    });
    // The block doesn't belong to the OTHER zone's day column.
    expect(eventDayPlacement(tzEvent, "2026-07-02", WEST)).toBeNull();
    expect(eventAccessibleName(tzEvent, "2026-07-02", EAST)).toContain("11:00 – 12:00");
  });

  it("floating + all-day events stay face value in any zone (gate unchanged)", () => {
    const floating = event({ start: "2026-07-01T09:00:00", timeZone: null, duration: "PT1H" });
    expect(displayStartParts(floating, WEST)).toEqual(parseDateParts("2026-07-01T09:00:00"));
    expect(displayStartParts(floating, EAST)).toEqual(parseDateParts("2026-07-01T09:00:00"));
    expect(formatTimeRange(floating, EAST)).toBe("09:00 – 10:00");
    const allDay = event({ start: "2026-07-01T00:00:00", showWithoutTime: true, duration: "P1D" });
    expect(eventCoversDays(allDay, WEST)).toEqual(["2026-07-01"]);
    expect(eventCoversDays(allDay, EAST)).toEqual(["2026-07-01"]);
  });

  it("groups events by their zone-local day", () => {
    const groupsWest = groupEventsByDay([tzEvent], new Date("2026-07-02T02:00:00Z"), WEST);
    const groupsEast = groupEventsByDay([tzEvent], new Date("2026-07-02T02:00:00Z"), EAST);
    expect(groupsWest.map((g) => g.key)).toEqual(["2026-07-01"]);
    expect(groupsEast.map((g) => g.key)).toEqual(["2026-07-02"]);
  });

  it("computes the {after,before} window from DISPLAY-ZONE day boundaries", () => {
    const anchor = new Date(2026, 6, 1); // carrier civil day July 1
    expect(visibleRange("day", anchor, WEST)).toEqual({
      after: "2026-07-01T04:00:00.000Z", // WEST-midnight Jul 1 = UTC−4
      before: "2026-07-02T04:00:00.000Z",
    });
    expect(visibleRange("day", anchor, EAST)).toEqual({
      after: "2026-06-30T15:00:00.000Z", // EAST-midnight Jul 1 = UTC+9
      before: "2026-07-01T15:00:00.000Z",
    });
    expect(visibleRange("day", anchor, "UTC")).toEqual({
      after: "2026-07-01T00:00:00.000Z",
      before: "2026-07-02T00:00:00.000Z",
    });
  });

  it("re-anchors the window across a DST transition (spring-forward day)", () => {
    // The one test that needs a REAL DST zone: 2026-03-08 America/New_York clocks jump 02:00→03:00, so
    // NY-midnight Mar 8 is still EST (−5) but Mar 9 is EDT (−4). The two-pass civil→instant must produce
    // both correctly (a one-pass guess would be off by 1h). Pinned to a long-settled US-DST date.
    expect(visibleRange("day", new Date(2026, 2, 8), "America/New_York")).toEqual({
      after: "2026-03-08T05:00:00.000Z",
      before: "2026-03-09T04:00:00.000Z",
    });
  });

  it("computes now-line, today, and the anchor in the display zone", () => {
    const now = new Date("2026-07-02T02:00:00Z"); // 22:00 Jul 1 WEST · 11:00 Jul 2 EAST
    expect(nowIndicatorOffset(now, "2026-07-01", WEST)).toBe(22 * 60);
    expect(nowIndicatorOffset(now, "2026-07-02", WEST)).toBeNull();
    expect(nowIndicatorOffset(now, "2026-07-02", EAST)).toBe(11 * 60);

    const anchorWest = todayAnchor(now, WEST);
    expect([anchorWest.getFullYear(), anchorWest.getMonth(), anchorWest.getDate()]).toEqual([
      2026, 6, 1,
    ]);
    const anchorEast = todayAnchor(now, EAST);
    expect([anchorEast.getFullYear(), anchorEast.getMonth(), anchorEast.getDate()]).toEqual([
      2026, 6, 2,
    ]);

    const weeksWest = monthGridWeeks(new Date(2026, 6, 1), now, WEST);
    const weeksEast = monthGridWeeks(new Date(2026, 6, 1), now, EAST);
    const todayOf = (weeks: ReturnType<typeof monthGridWeeks>) =>
      weeks.flat().find((c) => c.isToday)?.key;
    expect(todayOf(weeksWest)).toBe("2026-07-01");
    expect(todayOf(weeksEast)).toBe("2026-07-02");
  });

  it("seeds a new event's default slot in the display zone's wall-clock", () => {
    const now = new Date("2026-07-02T02:00:00Z");
    // Day mode anchored on the zone's "today" → today is in window → seed carries the zone time-of-day.
    const seedEast = createSeedDate("day", todayAnchor(now, EAST), now, EAST);
    expect([seedEast.getMonth(), seedEast.getDate(), seedEast.getHours()]).toEqual([6, 2, 11]);
    const seedWest = createSeedDate("day", todayAnchor(now, WEST), now, WEST);
    expect([seedWest.getMonth(), seedWest.getDate(), seedWest.getHours()]).toEqual([6, 1, 22]);
  });

  it("the default zone reproduces the un-zoned (Branch 1) result exactly", () => {
    const anchor = new Date(2026, 6, 1);
    const now = new Date("2026-07-02T02:00:00Z");
    expect(displayStartParts(tzEvent, LOCAL_ZONE)).toEqual(displayStartParts(tzEvent));
    expect(displayEndParts(tzEvent, LOCAL_ZONE)).toEqual(displayEndParts(tzEvent));
    expect(dayKey(tzEvent, LOCAL_ZONE)).toBe(dayKey(tzEvent));
    expect(visibleRange("month", anchor, LOCAL_ZONE)).toEqual(visibleRange("month", anchor));
    expect(nowIndicatorOffset(now, dayKey(tzEvent), LOCAL_ZONE)).toBe(
      nowIndicatorOffset(now, dayKey(tzEvent)),
    );
    expect(todayAnchor(now, LOCAL_ZONE).getTime()).toBe(todayAnchor(now).getTime());
    expect(formatTimeRange(tzEvent, LOCAL_ZONE)).toBe(formatTimeRange(tzEvent));
  });
});

describe("dropToSourceStart (drag reschedule inverse of placement)", () => {
  // FIXED-OFFSET zones so assertions are tzdb/DST-proof (Etc/GMT sign inverted: Etc/GMT+4 = UTC−4).
  const WEST = "Etc/GMT+4"; // UTC−4 display
  const SRC = "Etc/GMT-9"; // UTC+9 source zone (so source ≠ display, exercising the round-trip)

  // A timed event whose source zone is SRC (UTC+9): instant 2026-07-02T02:00:00Z = 11:00 Jul 2 in SRC.
  const tzEvent = event({
    start: "2026-07-02T11:00:00",
    timeZone: SRC,
    duration: "PT1H",
    utcStart: "2026-07-02T02:00:00Z",
    utcEnd: "2026-07-02T03:00:00Z",
  });

  it("inverts a display-zone drop back to the event's SOURCE-zone wall-clock", () => {
    // Drop at 22:00 (1320 min) on the WEST day 2026-07-01 — that display position is the instant
    // 2026-07-02T02:00:00Z, which in the SOURCE zone (UTC+9) is 11:00 Jul 2.
    expect(dropToSourceStart(tzEvent, "2026-07-01", 22 * 60, WEST)).toEqual({
      year: 2026,
      month: 7,
      day: 2,
      hour: 11,
      minute: 0,
      second: 0,
    });
  });

  it("round-trips with displayStartParts: drop where it's placed → its own source start", () => {
    // Placing the event in WEST puts it on 2026-07-01 at 22:00 (1320 min); dropping it right there must
    // recover the literal source start — the read (displayStartParts) and write (dropToSourceStart) use
    // the SAME convertsToViewerZone gate + instant, so the frames match exactly.
    const placed = displayStartParts(tzEvent, WEST);
    if (!placed) throw new Error("unreachable");
    const back = dropToSourceStart(tzEvent, "2026-07-01", placed.hour * 60 + placed.minute, WEST);
    expect(back).toEqual({ ...parseDateParts(tzEvent.start), second: 0 });
  });

  it("crosses a DST boundary correctly (real zone, two-pass civil→instant)", () => {
    // A NY-source event; drop on the WEST display day that maps across the US spring-forward. NY clocks
    // jump 02:00→03:00 on 2026-03-08, so the source projection of the dropped instant must honor the
    // post-transition offset. Pinned to a settled DST date.
    const ny = event({
      start: "2026-03-08T10:00:00",
      timeZone: "America/New_York",
      duration: "PT1H",
      utcStart: "2026-03-08T14:00:00Z", // 10:00 EDT
      utcEnd: "2026-03-08T15:00:00Z",
    });
    // Drop at 10:00 on the UTC display day → instant 2026-03-08T10:00:00Z → NY (EDT, −4) = 06:00.
    expect(dropToSourceStart(ny, "2026-03-08", 10 * 60, "UTC")).toEqual({
      year: 2026,
      month: 3,
      day: 8,
      hour: 6,
      minute: 0,
      second: 0,
    });
  });

  it("treats a floating event's drop as the face-value source start (no zone math)", () => {
    const floating = event({ start: "2026-07-01T09:00:00", timeZone: null, duration: "PT1H" });
    // The grid shows a floating event at face value, so the drop IS the source start — even when the
    // display zone is non-local, no projection happens.
    expect(dropToSourceStart(floating, "2026-07-05", 14 * 60 + 30, WEST)).toEqual({
      year: 2026,
      month: 7,
      day: 5,
      hour: 14,
      minute: 30,
      second: 0,
    });
  });

  it("rolls the date when a face-value drop runs past midnight", () => {
    const floating = event({ start: "2026-07-01T09:00:00", timeZone: null, duration: "PT1H" });
    // 1450 minutes = 24h10m → next day 00:10.
    expect(dropToSourceStart(floating, "2026-07-01", 1450, WEST)).toMatchObject({
      day: 2,
      hour: 0,
      minute: 10,
    });
  });

  it("returns null for a malformed day key", () => {
    expect(dropToSourceStart(tzEvent, "not-a-day", 540, WEST)).toBeNull();
  });

  it("fails closed (null) when the event's source zone is an invalid IANA zone", () => {
    // A tz-bearing event (converts) but carrying a bad source zone: projecting into it would silently
    // fall back to browser-local and compute a WRONG source start, so the write must refuse instead.
    const badZone = event({
      start: "2026-07-02T11:00:00",
      timeZone: "Mars/Phobos",
      duration: "PT1H",
      utcStart: "2026-07-02T02:00:00Z",
      utcEnd: "2026-07-02T03:00:00Z",
    });
    expect(dropToSourceStart(badZone, "2026-07-01", 22 * 60, WEST)).toBeNull();
  });
});

describe("dragCreateSeed (drag-to-create on the empty grid → create-form seed)", () => {
  const NY = "America/New_York";

  it("anchors the new event to the display zone at the swept wall-clock (not floating)", () => {
    // Sweep 09:00 (540) → 10:30 (630) on Jul 1, viewed in NY. The new event carries timeZone=NY and the
    // swept display wall-clock as its start/end — NOT floating (a floating create would expand to Etc/UTC
    // server-side and shift in a non-UTC zone — see the helper doc).
    const seed = dragCreateSeed("2026-07-01", 540, 630, NY);
    expect(seed).not.toBeNull();
    expect(seed?.timeZone).toBe(NY);
    expect(seed?.allDay).toBe(false);
    expect(seed?.title).toBe("");
    expect(seed?.start).toBe("2026-07-01T09:00");
    expect(seed?.end).toBe("2026-07-01T10:30");
  });

  it("orders the edges so an upward sweep (end above start) still yields start < end", () => {
    // Swept from 10:00 (600) UP to 08:00 (480): the seed normalizes to 08:00–10:00.
    const seed = dragCreateSeed("2026-07-01", 600, 480, NY);
    expect(seed?.start).toBe("2026-07-01T08:00");
    expect(seed?.end).toBe("2026-07-01T10:00");
  });

  it("defaults a zero-length tap to a sensible-length slot at the tapped time", () => {
    // Both edges collapse to 09:00 (a tap / a sweep snapped back to one grid line) → a default 60-min slot.
    const seed = dragCreateSeed("2026-07-01", 540, 540, NY);
    expect(seed?.start).toBe("2026-07-01T09:00");
    expect(seed?.end).toBe("2026-07-01T10:00");
  });

  it("honors a custom default slot length for a tap", () => {
    const seed = dragCreateSeed("2026-07-01", 540, 540, NY, 30);
    expect(seed?.start).toBe("2026-07-01T09:00");
    expect(seed?.end).toBe("2026-07-01T09:30");
  });

  it("keeps a tap's default slot inside the day (shifts it up near midnight)", () => {
    // Tap at 23:30 (1410): a 60-min default would spill past midnight, so the slot shifts to 23:00–24:00.
    const seed = dragCreateSeed("2026-07-01", 1410, 1410, NY);
    expect(seed?.start).toBe("2026-07-01T23:00");
    // 1440 minutes = the next day's 00:00 (gridParts rolls the date).
    expect(seed?.end).toBe("2026-07-02T00:00");
  });

  it("clamps a sweep to the day's bounds", () => {
    // A sweep beyond the day's extents (negative / past 24:00) clamps to [00:00, 24:00].
    const seed = dragCreateSeed("2026-07-01", -120, 2000, NY);
    expect(seed?.start).toBe("2026-07-01T00:00");
    expect(seed?.end).toBe("2026-07-02T00:00");
  });

  it("defaults the zone to the browser-local zone when none is passed", () => {
    expect(dragCreateSeed("2026-07-01", 540, 600)?.timeZone).toBe(LOCAL_ZONE);
  });

  it("clamps a degenerate defaultMin so a tap can't produce a zero/negative or multi-day slot", () => {
    // defaultMin <= 0 → a minimum 1-minute slot, not a zero/negative-length one.
    const tiny = dragCreateSeed("2026-07-01", 540, 540, NY, 0);
    expect(tiny?.start).toBe("2026-07-01T09:00");
    expect(tiny?.end).toBe("2026-07-01T09:01");
    // defaultMin > a full day → at most a full day (00:00 → next-day 00:00), never multi-day.
    const huge = dragCreateSeed("2026-07-01", 540, 540, NY, 5000);
    expect(huge?.start).toBe("2026-07-01T00:00");
    expect(huge?.end).toBe("2026-07-02T00:00");
  });

  it("returns null for a malformed day key", () => {
    expect(dragCreateSeed("not-a-day", 540, 600, NY)).toBeNull();
  });
});

describe("partsAddMs / partsUtcMs / dateTimeInput", () => {
  it("shifts parts by a millisecond delta via UTC arithmetic", () => {
    const p = { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 };
    expect(partsAddMs(p, 90 * 60_000)).toEqual({
      year: 2026,
      month: 7,
      day: 1,
      hour: 10,
      minute: 30,
      second: 0,
    });
    // Crosses a day boundary backwards.
    expect(partsAddMs(p, -10 * 60 * 60_000)).toMatchObject({ day: 30, month: 6, hour: 23 });
  });

  it("partsUtcMs differences equal a duration regardless of zone", () => {
    const a = { year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 };
    const b = { year: 2026, month: 7, day: 1, hour: 10, minute: 30, second: 0 };
    expect(partsUtcMs(b) - partsUtcMs(a)).toBe(90 * 60_000);
  });

  it("formats parts as a datetime-local input value", () => {
    expect(dateTimeInput({ year: 2026, month: 7, day: 1, hour: 9, minute: 5, second: 0 })).toBe(
      "2026-07-01T09:05",
    );
  });
});

describe("snapMinutes / pointerToGrid (drag engine geometry)", () => {
  it("snaps to the nearest step boundary", () => {
    expect(snapMinutes(547, 15)).toBe(540); // 09:07 → 09:00
    expect(snapMinutes(553, 15)).toBe(555); // 09:13 → 09:15
    expect(snapMinutes(660, 30)).toBe(660);
  });

  it("maps a pointer position to a day column + minutes-from-midnight", () => {
    const rect = { left: 0, top: 0, width: 700, height: 1440 }; // 7 cols × 100px; 1px = 1min
    expect(pointerToGrid(350, 540, rect, 7)).toEqual({ colIndex: 3, minutes: 540 });
    expect(pointerToGrid(0, 0, rect, 7)).toEqual({ colIndex: 0, minutes: 0 });
  });

  it("clamps the column and the minutes to the visible grid / day", () => {
    const rect = { left: 0, top: 0, width: 700, height: 1440 };
    expect(pointerToGrid(9999, 9999, rect, 7)).toEqual({ colIndex: 6, minutes: 1440 });
    expect(pointerToGrid(-50, -50, rect, 7)).toEqual({ colIndex: 0, minutes: 0 });
  });

  it("accounts for the rect offset (scrolled/positioned container)", () => {
    const rect = { left: 100, top: 200, width: 700, height: 1440 };
    expect(pointerToGrid(450, 740, rect, 7)).toEqual({ colIndex: 3, minutes: 540 });
  });
});

describe("resizeGeometry (drag-edge resize geometry)", () => {
  // A block at 09:00 (top 540) for 60 minutes (height 60); resize edges snap to 15 min, min 15 min.
  it("bottom edge: keeps the top fixed, snaps the bottom to a new duration", () => {
    expect(resizeGeometry("bottom", 540, 60, 632, 15, 15)).toEqual({
      topMin: 540,
      durationMin: 90,
    });
    // 632 → snap 630 → bottom 630 → duration 90.
  });

  it("top edge: keeps the bottom fixed, snaps the top to a new start + duration", () => {
    // bottom = 540 + 60 = 600; drag the top up to ~08:00 (480).
    expect(resizeGeometry("top", 540, 60, 482, 15, 15)).toEqual({ topMin: 480, durationMin: 120 });
  });

  it("floors the bottom so the block can't shrink below the minimum (no invert/zero)", () => {
    // Dragging the bottom up above the top + min → clamped to top + min, never inverted.
    expect(resizeGeometry("bottom", 540, 60, 500, 15, 15)).toEqual({
      topMin: 540,
      durationMin: 15,
    });
  });

  it("caps the top so the block can't shrink below the minimum from above", () => {
    // bottom = 600; dragging the top down past bottom − min → clamped to bottom − min.
    expect(resizeGeometry("top", 540, 60, 700, 15, 15)).toEqual({ topMin: 585, durationMin: 15 });
  });

  it("clamps the bottom to the end of the day", () => {
    expect(resizeGeometry("bottom", 1380, 30, 2000, 15, 15)).toEqual({
      topMin: 1380,
      durationMin: 60, // bottom clamped to 1440 (midnight) → 60 min
    });
  });

  it("clamps the top to the start of the day", () => {
    // bottom = 60; dragging the top above midnight → clamped to 0.
    expect(resizeGeometry("top", 30, 30, -50, 15, 15)).toEqual({ topMin: 0, durationMin: 60 });
  });

  it("keeps the MOVED edge on the snap grid when the fixed edge is off-grid (09:07 start)", () => {
    // anchorTopMin=547 (09:07). Dragging the bottom toward the minimum must land it on a grid line, not
    // at the off-grid floor 547+15=562. minBottom = ceil(562/15)*15 = 570.
    const r = resizeGeometry("bottom", 547, 60, 560, 15, 15);
    expect((r.topMin + r.durationMin) % 15).toBe(0); // the moved (bottom) edge is grid-aligned
    expect(r.topMin + r.durationMin).toBe(570);
    expect(r.topMin).toBe(547); // the fixed top is left exactly where it is
  });

  it("keeps the MOVED top edge on the snap grid when the fixed bottom is fractional (seconds)", () => {
    // anchorTopMin=540.5 (09:00:30), height 60 → fixed bottom 600.5. Dragging the top toward the minimum
    // must land it on a grid line: maxTop = floor((600.5−15)/15)*15 = floor(585.5/15)*15 = 585.
    const r = resizeGeometry("top", 540.5, 60, 700, 15, 15);
    expect(r.topMin % 15).toBe(0); // the moved (top) edge is grid-aligned
    expect(r.topMin).toBe(585);
    expect(r.topMin + r.durationMin).toBe(600.5); // the fixed bottom is left exactly where it is
  });
});

describe("eventEndDayKey", () => {
  it("returns the display-end day key (same day for a within-day timed event)", () => {
    const e = event({ start: "2026-07-01T09:00:00", duration: "PT1H" });
    expect(eventEndDayKey(e)).toBe("2026-07-01");
    expect(dayKey(e)).toBe("2026-07-01");
  });

  it("returns the NEXT day for a midnight-crossing event (so its block isn't single-day)", () => {
    const e = event({ start: "2026-07-01T23:00:00", duration: "PT2H" }); // → 01:00 Jul 2
    expect(dayKey(e)).toBe("2026-07-01");
    expect(eventEndDayKey(e)).toBe("2026-07-02");
  });

  it("falls back to the start when there's no end", () => {
    const e = event({ start: "2026-07-01T09:00:00" });
    expect(eventEndDayKey(e)).toBe("2026-07-01");
  });

  it("returns '' for an unparseable start", () => {
    expect(eventEndDayKey(event({ start: "nope" }))).toBe("");
  });
});
