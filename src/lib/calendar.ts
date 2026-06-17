// Pure helpers for the read-only calendar view: parse a JSCalendar event's local date-time + ISO-8601
// duration, format the time range / day heading, group events into agenda day buckets, and summarize a
// recurrence rule in prose. No SolidJS, no JMAP client — data → data, unit-tested in isolation.
//
// JSCalendar (RFC 8984) `start` is a LOCAL date-time string (no `Z`/offset) interpreted in the event's
// `timeZone`; an all-day event is `showWithoutTime` with a date-valued `duration`. We deliberately do
// NOT push these through `new Date(string)` (which would apply the runtime's timezone and shift the
// wall-clock value) — we parse the components verbatim and only use UTC date math (Date.UTC) so the
// displayed day/time matches what the server sent, regardless of where the client runs.

import type { Calendar, CalendarEvent, RecurrenceRule } from "@/jmap/types";

/** A calendar date-time broken into its literal components (no timezone applied). */
export interface DateParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// End-anchored: a JSCalendar LocalDateTime carries NO trailing `Z`/offset (RFC 8984 §1.4.5), so a
// value like "2026-09-07T09:00:00Z" or any trailing garbage is malformed and must be rejected, not
// silently truncated. Seconds (group 6) are captured (any fraction discarded) so the sort can order
// same-minute events; the display helpers ignore them.
const LOCAL_DT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * Parse a JSCalendar local date-time ("2026-09-07T09:00:00" or a bare date) into its parts, or null
 * for malformed input. Rejects trailing characters (the regex is end-anchored) AND out-of-range
 * components — otherwise the downstream UTC date math would silently normalize e.g. "2026-13-40" into
 * a wrong-but-plausible date, which is worse than showing nothing.
 */
export function parseDateParts(s: string | undefined): DateParts | null {
  if (!s) return null;
  const m = LOCAL_DT.exec(s);
  if (!m) return null;
  const parts: DateParts = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] ? Number(m[4]) : 0,
    minute: m[5] ? Number(m[5]) : 0,
    second: m[6] ? Number(m[6]) : 0,
  };
  // Validate by round-tripping through a UTC date: any impossible field — month 13, an invalid
  // day-of-month (Feb 31, Apr 31, Feb 29 in a non-leap year), hour 25, minute 60, second 60 —
  // normalizes to a different instant, so a component mismatch means the input was malformed. This
  // subsumes simple range checks AND honors per-month/leap-year day limits in one pass.
  const d = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
  );
  if (
    d.getUTCFullYear() !== parts.year ||
    d.getUTCMonth() !== parts.month - 1 ||
    d.getUTCDate() !== parts.day ||
    d.getUTCHours() !== parts.hour ||
    d.getUTCMinutes() !== parts.minute ||
    d.getUTCSeconds() !== parts.second
  ) {
    return null;
  }
  return parts;
}

interface Duration {
  years: number;
  months: number;
  days: number;
  ms: number;
}

const ISO_DURATION =
  /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Parse an ISO-8601 duration ("PT1H", "P1D", "PT30M") into normalized parts. Null if malformed. */
export function parseDuration(s: string | undefined): Duration | null {
  if (!s) return null;
  const m = ISO_DURATION.exec(s);
  // Reject a degenerate "P"/"PT" with no components (every capture group empty).
  if (!m?.slice(1).some(Boolean)) return null;
  const n = (i: number) => (m[i] ? Number(m[i]) : 0);
  return {
    years: n(1),
    months: n(2),
    days: n(3) * 7 + n(4), // weeks fold into days
    ms: (n(5) * 3600 + n(6) * 60 + n(7)) * 1000,
  };
}

/** Whether the event is all-day (a date with no clock time). */
export function isAllDay(event: CalendarEvent): boolean {
  return event.showWithoutTime === true;
}

/** Whether the event is recurring or an expanded occurrence of a series (drives the ↻ glyph). */
export function isRecurring(event: CalendarEvent): boolean {
  return Boolean(event.recurrenceRule || event.recurrenceId);
}

/** The event's start parts, or null when it has no parseable start. */
export function eventStartParts(event: CalendarEvent): DateParts | null {
  return parseDateParts(event.start);
}

/**
 * The event's end parts = start + duration, computed in UTC so DST/local offsets never shift it.
 * Returns the start when there's no duration. Null when the event has no parseable start.
 */
export function eventEndParts(event: CalendarEvent): DateParts | null {
  const start = eventStartParts(event);
  if (!start) return null;
  // An all-day event with no explicit duration defaults to one day (RFC 8984 §4.1.2) — iCal-imported
  // all-day events frequently omit `duration`. Without this an all-day event would read as a spurious
  // two-day range in formatTimeRange (which steps the inclusive end back a day).
  const dur =
    parseDuration(event.duration) ??
    (isAllDay(event) ? { years: 0, months: 0, days: 1, ms: 0 } : null);
  if (!dur) return start;
  const d = new Date(
    Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, start.second),
  );
  if (dur.years) d.setUTCFullYear(d.getUTCFullYear() + dur.years);
  if (dur.months) d.setUTCMonth(d.getUTCMonth() + dur.months);
  if (dur.days) d.setUTCDate(d.getUTCDate() + dur.days);
  if (dur.ms) d.setTime(d.getTime() + dur.ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function hhmm(p: DateParts): string {
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function sameYmd(a: DateParts, b: DateParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthDay(p: DateParts): string {
  return `${MONTHS[p.month - 1] ?? ""} ${p.day}`;
}

/**
 * The event's time range for a row / detail line: "All day", "09:00 – 09:30", or — when it spans
 * days — "Sep 7 09:00 – Sep 9 10:00". An all-day event spanning multiple days reads "Sep 7 – Sep 9".
 * Returns "" when the start is unparseable.
 */
export function formatTimeRange(event: CalendarEvent): string {
  const start = eventStartParts(event);
  if (!start) return "";
  const end = eventEndParts(event) ?? start;
  if (isAllDay(event)) {
    // All-day durations are exclusive of the end date (P1D = a single day), so step back one day.
    const last = stepDays(end, -1);
    return sameYmd(start, last) ? "All day" : `${monthDay(start)} – ${monthDay(last)}`;
  }
  if (sameYmd(start, end)) return `${hhmm(start)} – ${hhmm(end)}`;
  return `${monthDay(start)} ${hhmm(start)} – ${monthDay(end)} ${hhmm(end)}`;
}

// Shift date parts by whole days (UTC math), dropping the clock time. Used for all-day end handling.
function stepDays(p: DateParts, days: number): DateParts {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() + days);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/** A "YYYY-MM-DD" key for the event's start date — the agenda's day-bucket key. "" if unparseable. */
export function dayKey(event: CalendarEvent): string {
  const p = eventStartParts(event);
  return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : "";
}

/** A human day heading for a "YYYY-MM-DD" key, e.g. "Mon, Sep 7" (with year when not `now`'s year). */
export function formatDayHeading(key: string, now: Date = new Date()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  const weekday = WEEKDAYS[d.getUTCDay()] ?? "";
  const base = `${weekday}, ${MONTHS[month - 1] ?? ""} ${day}`;
  return year === now.getFullYear() ? base : `${base}, ${year}`;
}

/** The event's title, or a stable placeholder so a row/heading always has something to show. */
export function eventDisplayTitle(event: CalendarEvent): string {
  return event.title?.trim() || "(no title)";
}

// Sort key: start instant (UTC-built from the literal parts, including seconds so same-minute events
// order correctly) then title, for a deterministic order.
function startSortKey(event: CalendarEvent): number {
  const p = eventStartParts(event);
  if (!p) return Number.POSITIVE_INFINITY; // undated events sort last
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Compare two events by start then title — the deterministic agenda order. */
export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  const byStart = startSortKey(a) - startSortKey(b);
  if (byStart !== 0) return byStart;
  const byTitle = eventDisplayTitle(a).localeCompare(eventDisplayTitle(b), undefined, {
    sensitivity: "base",
  });
  return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id);
}

/**
 * Order calendars for the sidebar: the default calendar first, then by the server `sortOrder`, then
 * by name (locale-aware), tie-broken by id for stability. Mirrors `compareAddressBooks` — the same
 * isDefault → sortOrder → name → id rule — kept here so the comparator is testable in isolation and
 * components import it (rather than inlining the rule).
 */
export function compareCalendars(a: Calendar, b: Calendar): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/** One agenda day group: the date key, its heading, and the day's events (start-sorted). */
export interface DayGroup {
  key: string;
  heading: string;
  events: CalendarEvent[];
}

/**
 * Group events into agenda day buckets keyed by start date, each sorted by start, the groups in
 * chronological order. Events with no parseable start are dropped (nothing to place them under).
 */
export function groupEventsByDay(events: CalendarEvent[], now: Date = new Date()): DayGroup[] {
  const buckets = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = dayKey(event);
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(event);
    else buckets.set(key, [event]);
  }
  return [...buckets.keys()].sort().map((key) => ({
    key,
    heading: formatDayHeading(key, now),
    events: (buckets.get(key) ?? []).sort(compareEvents),
  }));
}

const FREQ_LABEL: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};
const FREQ_UNIT: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};
const DAY_NAMES: Record<string, string> = {
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
  su: "Sunday",
};

/**
 * A short human-readable summary of a recurrence rule, e.g. "Weekly on Monday", "Every 2 weeks",
 * "Daily, 10 times". Returns null when there's no rule (so the badge is hidden); an unrecognized
 * frequency degrades to "Repeats". Kept deliberately compact for a read-only badge.
 */
export function recurrenceSummary(rule: RecurrenceRule | undefined): string | null {
  if (!rule?.frequency) return null;
  const freq = rule.frequency.toLowerCase();
  const interval = rule.interval && rule.interval > 1 ? rule.interval : 1;
  const unit = FREQ_UNIT[freq];
  let summary: string;
  if (interval > 1) summary = unit ? `Every ${interval} ${unit}s` : "Repeats";
  else summary = FREQ_LABEL[freq] ?? "Repeats";

  const days = (rule.byDay ?? [])
    .map((d) => DAY_NAMES[d.day?.toLowerCase() ?? ""])
    .filter((d): d is string => Boolean(d));
  if (days.length > 0) summary += ` on ${days.join(", ")}`;

  if (rule.count && rule.count > 0) summary += `, ${rule.count} times`;
  else if (rule.until) {
    const until = parseDateParts(rule.until);
    if (until) summary += `, until ${monthDay(until)}`;
  }
  return summary;
}
