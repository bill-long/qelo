import { describe, expect, it } from "vitest";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import {
  compareCalendars,
  compareEvents,
  createdEventFor,
  createEventBody,
  createEventError,
  createSeedDate,
  dayKey,
  defaultWritableCalendarId,
  type EditableEvent,
  editableHasContent,
  emptyEditableEvent,
  eventAccessibleName,
  eventCoversDays,
  eventDayPlacement,
  eventDisplayTitle,
  eventEndParts,
  formatDayHeading,
  formatTimeRange,
  freshOccurrenceIdForBase,
  groupEventsByDay,
  isAllDay,
  isRecurring,
  layoutAllDayLane,
  layoutMonth,
  monthGridWeeks,
  nowIndicatorOffset,
  packDayColumns,
  parseDateParts,
  parseDuration,
  rangeLabel,
  recurrenceSummary,
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
