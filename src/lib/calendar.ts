// Pure helpers for the read-only calendar view: parse a JSCalendar event's local date-time + ISO-8601
// duration, format the time range / day heading, group events into agenda day buckets, and summarize a
// recurrence rule in prose. No SolidJS, no JMAP client — data → data, unit-tested in isolation.
//
// JSCalendar (RFC 8984) `start` is a LOCAL date-time string (no `Z`/offset) interpreted in the event's
// `timeZone`; an all-day event is `showWithoutTime` with a date-valued `duration`. The PARSING layer
// deliberately does NOT push `start` through `new Date(string)` (which would apply the runtime's
// timezone and shift the wall-clock value) — it parses the components verbatim and uses only UTC date
// math (Date.UTC). On top of that, the viewer-tz layer (see `convertsToViewerZone`/`displayStartParts`)
// converts a TIMED event carrying a real `timeZone` into the viewer's zone for display via the server's
// absolute `utcStart`/`utcEnd`; floating + all-day events stay at their verbatim face value.

import type { CalendarEventPatch } from "@/jmap/methods";
import type { Calendar, CalendarEvent, EventLocation, NDay, RecurrenceRule } from "@/jmap/types";

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

/**
 * Whether two JSCalendar LocalDateTime strings denote the SAME instant, tolerant of format differences
 * (omitted vs included seconds, a fractional part) — both are parsed to their literal components and
 * compared, so "2026-09-07T09:00" and "2026-09-07T09:00:00" match. Returns false when EITHER is
 * unparseable/absent, so an unknown value never spuriously matches (callers that gate a destructive
 * branch on equality then take the safe non-equal path). Pure. */
export function sameLocalDateTime(a: string | undefined, b: string | undefined): boolean {
  const pa = parseDateParts(a);
  const pb = parseDateParts(b);
  if (!pa || !pb) return false;
  return (
    pa.year === pb.year &&
    pa.month === pb.month &&
    pa.day === pb.day &&
    pa.hour === pb.hour &&
    pa.minute === pb.minute &&
    pa.second === pb.second
  );
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

// ---------------------------------------------------------------------------
// Viewer-timezone conversion (viewer-tz milestone, Branch 1). A timed event carries a LOCAL `start`
// interpreted in its own `timeZone`; the server also computes the absolute `utcStart`/`utcEnd`
// instants (RFC 8984, opt-in — see CALENDAR_EVENT_PROPERTIES). For PLACEMENT/GROUPING/LABELS we want
// the event shown in the VIEWER's frame, so we convert that instant to the viewer's zone (Branch 1:
// browser-local; Branch 2 will make the zone selectable). This is DISPLAY-ONLY — the editable model
// (`eventToEditable`) still reads the literal `start`/`timeZone`, the event's source-of-truth.
//
// Floating events (`timeZone` null/absent) and all-day events do NOT convert — a floating 09:00
// "floats" to 09:00 in any zone (decided), and all-day is date-based. So the conversion gate is
// exactly "a timed event with a real IANA `timeZone`"; everything else uses its literal components.
// ---------------------------------------------------------------------------

/**
 * Whether the event's instants should be converted to the viewer's zone for display: a TIMED event
 * (not all-day) carrying a non-empty IANA `timeZone` AND BOTH server-computed instants (`utcStart` +
 * `utcEnd`) that PARSE. Floating/all-day events, and any event missing OR with an unparseable instant
 * (older/partial/malformed server), render at face value. Requiring both instants to parse is what
 * keeps the start and end in ONE frame — converting the start from `utcStart` while the end fell back
 * to the literal source-zone time (because `utcEnd` was absent or unparseable) would mix frames and
 * produce a backwards/oversized range. The gate is zone-INDEPENDENT (Branch 2's selectable zone
 * doesn't change WHETHER an event converts, only the target zone), so it carries forward unchanged.
 */
function convertsToViewerZone(event: CalendarEvent): boolean {
  return (
    !isAllDay(event) &&
    typeof event.timeZone === "string" &&
    event.timeZone.length > 0 &&
    localPartsFromUtc(event.utcStart) !== null &&
    localPartsFromUtc(event.utcEnd) !== null
  );
}

/** The browser-local {@link DateParts} of a UTC instant string ("…Z"), or null when unparseable.
 * `new Date(iso)` is the absolute instant; the local getters read it in the browser's zone (Branch 1's
 * frame — Branch 2 generalizes this to an Intl-selected zone). */
function localPartsFromUtc(utc: string | undefined): DateParts | null {
  if (!utc) return null;
  const ms = Date.parse(utc);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  };
}

// The viewer-zone parts of one of the event's instants, or null to signal "use face value". Shared by
// the start/end display helpers so the convert-or-literal decision is made identically for both — when
// the event doesn't convert (floating/all-day/missing-instant) BOTH fall back to their literal parts,
// never one converted and one literal.
function viewerInstantParts(event: CalendarEvent, instant: string | undefined): DateParts | null {
  return convertsToViewerZone(event) ? localPartsFromUtc(instant) : null;
}

/**
 * The event's start parts AS DISPLAYED in the viewer's zone: for a timed event with a real `timeZone`
 * and both server-computed instants, the browser-local parts of `utcStart`; otherwise (floating,
 * all-day, or an instant absent on an older server) the literal {@link eventStartParts}, face value.
 * The single helper every placement/grouping/label path uses so they share one frame. Pure.
 */
export function displayStartParts(event: CalendarEvent): DateParts | null {
  return viewerInstantParts(event, event.utcStart) ?? eventStartParts(event);
}

/** The event's end parts as displayed in the viewer's zone — the {@link displayStartParts} rule on
 * `utcEnd` (the server's `start`+`duration` instant), else literal {@link eventEndParts}. Converts in
 * lockstep with the start (same {@link convertsToViewerZone} gate), never in a different frame. */
export function displayEndParts(event: CalendarEvent): DateParts | null {
  return viewerInstantParts(event, event.utcEnd) ?? eventEndParts(event);
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
// Full month names for the month-view header ("June 2026"); the abbreviations above are for compact
// day headings / spans.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
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
  const start = displayStartParts(event);
  if (!start) return "";
  const end = displayEndParts(event) ?? start;
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

/** A "YYYY-MM-DD" key for the event's start date AS DISPLAYED in the viewer's zone — the agenda's
 * day-bucket key. "" if unparseable. */
export function dayKey(event: CalendarEvent): string {
  const p = displayStartParts(event);
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

// Sort key: start instant as DISPLAYED in the viewer's zone (UTC-built from the display parts,
// including seconds so same-minute events order correctly) then title, for a deterministic order that
// matches the rendered order (a tz-converted event sorts by where it's shown, not its source-zone time).
function startSortKey(event: CalendarEvent): number {
  const p = displayStartParts(event);
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

// ---------------------------------------------------------------------------
// View navigation — the view-mode + a navigable date window (Calendar Views milestone). Pure date
// math: the store turns `visibleRange` into the CalendarEvent/query window; the nav header uses
// `stepAnchor`/`todayAnchor`/`rangeLabel`. LOCAL-midnight based (matching the agenda's original
// window) so the displayed calendar dates are the user's local days. The anchor is always a local-
// midnight Date; every helper re-normalizes its input so a caller can pass any instant.
// ---------------------------------------------------------------------------

/** Which calendar view the surface renders. agenda = the scrollable upcoming list (the CRUD v1);
 * day/week = the time-grid; month = the day-cell grid. */
export type CalendarViewMode = "agenda" | "day" | "week" | "month";

/** How many days forward the agenda spans from its anchor (the rolling "upcoming" window). */
export const AGENDA_WINDOW_DAYS = 56;

/** Local midnight of `d` (clock dropped), as a fresh Date — the canonical anchor shape. */
function localMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The Sunday on/before `d` at local midnight — the week/month grid's first column. */
function startOfWeek(d: Date): Date {
  const m = localMidnight(d);
  m.setDate(m.getDate() - m.getDay()); // getDay(): 0 = Sunday
  return m;
}

/**
 * The padded month grid's [start, end) as local-midnight Dates: the Sunday on/before the 1st through
 * the Sunday after the week containing the last day (whole Sun-start weeks). The SINGLE source for both
 * {@link visibleRange}("month") (the JMAP query window) and {@link monthGridWeeks} (the rendered
 * cells), so the fetched window and the grid can never diverge.
 */
function monthGridBounds(anchor: Date): { start: Date; end: Date } {
  const start = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const end = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0));
  end.setDate(end.getDate() + 7); // exclusive: the Sunday after the last visible week
  return { start, end };
}

/** Today at local midnight — the default anchor and the "Today" reset target. */
export function todayAnchor(now: Date = new Date()): Date {
  return localMidnight(now);
}

/**
 * The `CalendarEvent/query` window `{after,before}` (UTC instants) for a view mode + anchor date.
 * `before` is EXCLUSIVE (the instant after the last visible day). Each window is small (≤ ~6 weeks),
 * comfortably within Stalwart's `maxExpandedQueryDuration` (P52W1D) — which dev Stalwart doesn't even
 * enforce — and each nav step re-queries rather than accumulating. Stalwart's `{after,before}` filters
 * on OVERLAP (probed live 2026-06-17), so a multi-day event spanning into the window is returned; the
 * grids clip its rendered span to the visible days.
 *  - month: the anchor's month padded out to whole weeks (Sun-start) — the 5/6-row grid range.
 *  - week:  the Sun…Sat week containing the anchor.
 *  - day:   the single anchor day.
 *  - agenda: anchor → anchor + {@link AGENDA_WINDOW_DAYS} (the rolling upcoming list).
 */
export function visibleRange(
  mode: CalendarViewMode,
  anchor: Date,
): { after: string; before: string } {
  if (mode === "month") {
    const { start, end } = monthGridBounds(anchor);
    return { after: start.toISOString(), before: end.toISOString() };
  }
  const from = mode === "week" ? startOfWeek(anchor) : localMidnight(anchor);
  const days = mode === "week" ? 7 : mode === "day" ? 1 : AGENDA_WINDOW_DAYS;
  const before = new Date(from);
  before.setDate(before.getDate() + days);
  return { after: from.toISOString(), before: before.toISOString() };
}

/**
 * Move the anchor one view-window in `dir` (+1 forward / −1 back): month → ±1 month, week → ±7 days,
 * day → ±1 day, agenda → ±{@link AGENDA_WINDOW_DAYS}. Returns a fresh local-midnight Date. The MONTH
 * step first pins the day to the 1st — `setMonth` OVERFLOWS a too-large day (stepping from Jan 31 would
 * land on Mar 3, SKIPPING February), and the month view ignores the anchor's day anyway (the window is
 * derived from the month) — so stepping month-to-month off the 1st is exact and never skips a month.
 */
export function stepAnchor(mode: CalendarViewMode, anchor: Date, dir: 1 | -1): Date {
  const a = localMidnight(anchor);
  if (mode === "month") {
    a.setDate(1);
    a.setMonth(a.getMonth() + dir);
  } else if (mode === "week") a.setDate(a.getDate() + 7 * dir);
  else if (mode === "day") a.setDate(a.getDate() + dir);
  else a.setDate(a.getDate() + AGENDA_WINDOW_DAYS * dir);
  return a;
}

// A span label for the nav header: same-month "Jun 14 – 20", cross-month "Jun 29 – Jul 5", cross-year
// "Dec 29, 2026 – Jan 4, 2027" (both years, since one trailing year would be ambiguous for the left
// endpoint). The year is appended once (trailing) for a same-year span that isn't the current year.
function formatSpanLabel(start: Date, end: Date, now: Date): string {
  const sM = MONTHS[start.getMonth()] ?? "";
  const eM = MONTHS[end.getMonth()] ?? "";
  if (start.getFullYear() !== end.getFullYear()) {
    return `${sM} ${start.getDate()}, ${start.getFullYear()} – ${eM} ${end.getDate()}, ${end.getFullYear()}`;
  }
  const left = `${sM} ${start.getDate()}`;
  const right = start.getMonth() === end.getMonth() ? `${end.getDate()}` : `${eM} ${end.getDate()}`;
  const yearSuffix = start.getFullYear() === now.getFullYear() ? "" : `, ${start.getFullYear()}`;
  return `${left} – ${right}${yearSuffix}`;
}

/** A human label for the current view window, for the nav header: month → "June 2026", week →
 * "Jun 14 – 20", day → "Wed, Jun 17", agenda → "Jun 17 – Aug 11". `now` parameterized for tests. */
export function rangeLabel(mode: CalendarViewMode, anchor: Date, now: Date = new Date()): string {
  const a = localMidnight(anchor);
  if (mode === "month") return `${MONTH_NAMES[a.getMonth()] ?? ""} ${a.getFullYear()}`;
  // Day mode is exactly a one-day heading — reuse formatDayHeading (same "Wed, Jun 17[, year]" rule)
  // rather than re-encoding the format, so the nav header and the agenda day headings can't drift.
  if (mode === "day") {
    return formatDayHeading(
      `${a.getFullYear()}-${pad2(a.getMonth() + 1)}-${pad2(a.getDate())}`,
      now,
    );
  }
  const start = mode === "week" ? startOfWeek(a) : a;
  const end = new Date(start);
  end.setDate(end.getDate() + (mode === "week" ? 6 : AGENDA_WINDOW_DAYS - 1));
  return formatSpanLabel(start, end, now);
}

/**
 * The Date to seed a NEW event's default slot from, given the visible window: `now` when today is in
 * view (the familiar next-hour-today default), otherwise the anchor's day at the current time-of-day.
 * So a create made while the window is navigated away from today lands somewhere VISIBLE (in the window
 * the user is looking at) instead of on today — off-window, where the reconcile re-query would drop it
 * from view. Feeds {@link emptyEditableEvent}; pure, `now` parameterized for tests.
 */
export function createSeedDate(mode: CalendarViewMode, anchor: Date, now: Date = new Date()): Date {
  const { after, before } = visibleRange(mode, anchor);
  const todayMs = localMidnight(now).getTime();
  if (todayMs >= Date.parse(after) && todayMs < Date.parse(before)) return now;
  return new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate(),
    now.getHours(),
    now.getMinutes(),
  );
}

// ---------------------------------------------------------------------------
// Month grid (Calendar Views milestone, Branch B). Pure layout for a Sun-start day-cell grid (4–6
// rows of 7): the week×day matrix of dates (monthGridWeeks), the inclusive day-keys an event spans
// (eventCoversDays), and the per-week lane assignment of event segments with overflow (layoutMonth).
// Day math is UTC-on-the-literal-components (no DST shift), matching visibleRange and the rest of this
// file — a "YYYY-MM-DD" is treated as a UTC-midnight scalar purely for comparison/enumeration, never
// as a tz-bearing instant.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A single month-grid day cell: its "YYYY-MM-DD" key, day-of-month number, whether it belongs to the
 * anchor's month (vs a leading/trailing adjacent-month day, which the UI dims), and whether it's today. */
export interface DayCell {
  key: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
}

// "YYYY-MM-DD" for a Date's LOCAL calendar day (the grid is local-day based, like visibleRange).
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// UTC-midnight ms for a "YYYY-MM-DD" key — the canonical scalar for day comparisons/enumeration.
function keyToUtcMs(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
}

/**
 * The month's day cells as a weeks×7 matrix, Sun-start, padded with adjacent-month days out to whole
 * weeks (4–6 rows depending on the month's length + start weekday) — exactly the range
 * {@link visibleRange}("month") queries. `now` parameterized for deterministic today-flagging in tests.
 */
export function monthGridWeeks(anchor: Date, now: Date = new Date()): DayCell[][] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const { start: gridStart, end: gridEnd } = monthGridBounds(anchor);
  const todayKey = localDateKey(now);
  const weeks: DayCell[][] = [];
  const d = new Date(gridStart);
  while (d < gridEnd) {
    const week: DayCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const key = localDateKey(d);
      week.push({
        key,
        day: d.getDate(),
        inMonth: d.getFullYear() === year && d.getMonth() === month,
        isToday: key === todayKey,
      });
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

// The event's covered-day span as UTC-midnight ms [firstMs, lastMs], or null when it has no parseable
// start. Half-open in time: an end exactly at local midnight — including an all-day P{n}D duration,
// whose computed end is exclusive — occupies no time on that final day, so the last covered day steps
// back, covering both the all-day exclusive-end AND a timed event ending at 00:00 in one rule. Clamped
// so lastMs ≥ firstMs (a malformed end-before-start collapses to the start day).
function eventDayRange(event: CalendarEvent): { firstMs: number; lastMs: number } | null {
  const start = displayStartParts(event);
  if (!start) return null;
  const end = displayEndParts(event) ?? start;
  const firstMs = Date.UTC(start.year, start.month - 1, start.day);
  const endDayMs = Date.UTC(end.year, end.month - 1, end.day);
  const endAtMidnight = end.hour === 0 && end.minute === 0 && end.second === 0;
  let lastMs = endAtMidnight && endDayMs > firstMs ? endDayMs - DAY_MS : endDayMs;
  if (lastMs < firstMs) lastMs = firstMs;
  return { firstMs, lastMs };
}

/** The inclusive set of "YYYY-MM-DD" day-keys an event covers (one for a single-day event, the
 * contiguous range for a multi-day/all-day span). Empty when the start is unparseable. */
export function eventCoversDays(event: CalendarEvent): string[] {
  const range = eventDayRange(event);
  if (!range) return [];
  const out: string[] = [];
  for (let ms = range.firstMs; ms <= range.lastMs; ms += DAY_MS) {
    const d = new Date(ms);
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  }
  return out;
}

/** How many event lanes a month cell shows before collapsing the rest into "+N more". */
export const MONTH_VISIBLE_LANES = 3;

/** One positioned event in a month week row: the event, its clipped column span [startCol,endCol]
 * (0–6, inclusive), its lane (vertical row within the cell band), whether the span continues beyond
 * this week (so the bar renders an open edge), and whether it's a multi-day/all-day BAR vs a
 * single-day CHIP. */
export interface MonthSegment {
  event: CalendarEvent;
  startCol: number;
  endCol: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  isSpan: boolean;
}

/** A month week row's layout: the visible segments (lane < the visible-lane cap) and, per column
 * (0–6), the count of hidden segments covering that day (the "+N more" overflow). */
export interface MonthWeekLayout {
  segments: MonthSegment[];
  overflow: number[];
}

/**
 * Lay events into each week row of `weeks`: assign every event covering the week a column span + a
 * lane (greedy — the lowest lane with no column-overlap), so multi-day BARS and single-day CHIPS share
 * one collision-free lane grid (a chip never renders under a bar). Spans are clipped to the week and
 * flagged continuesBefore/After (the {after,before} query returns events overlapping the window, so a
 * span can start before / end after a given row). Segments past `visibleLanes` are hidden and counted
 * per covered column as overflow ("+N more"). Deterministic order — earlier start, then longer span,
 * then bars before chips, then {@link compareEvents} — so the layout is stable across renders. Pure.
 */
export function layoutMonth(
  events: CalendarEvent[],
  weeks: DayCell[][],
  visibleLanes: number = MONTH_VISIBLE_LANES,
): MonthWeekLayout[] {
  // Precompute each event's day range + bar/chip class once (skip the unparseable).
  const items = events
    .map((event) => {
      const range = eventDayRange(event);
      return range
        ? { event, ...range, isSpan: isAllDay(event) || range.lastMs > range.firstMs }
        : null;
    })
    .filter((it): it is NonNullable<typeof it> => it !== null);

  return weeks.map((week) => {
    const first = week[0];
    const last = week[week.length - 1];
    if (!first || !last) return { segments: [], overflow: new Array<number>(7).fill(0) };
    const week0 = keyToUtcMs(first.key);
    const week6 = keyToUtcMs(last.key);

    const inWeek = items
      .filter((it) => it.lastMs >= week0 && it.firstMs <= week6)
      .map((it) => ({
        event: it.event,
        isSpan: it.isSpan,
        startCol: Math.max(0, Math.round((it.firstMs - week0) / DAY_MS)),
        endCol: Math.min(6, Math.round((it.lastMs - week0) / DAY_MS)),
        continuesBefore: it.firstMs < week0,
        continuesAfter: it.lastMs > week6,
      }))
      .sort(
        (a, b) =>
          a.startCol - b.startCol ||
          b.endCol - b.startCol - (a.endCol - a.startCol) || // longer span first
          (a.isSpan === b.isSpan ? 0 : a.isSpan ? -1 : 1) || // bars before chips
          compareEvents(a.event, b.event),
      );

    // Greedy lane packing: place each segment in the lowest lane whose occupied column ranges don't
    // overlap it; segments past the visible cap fall into per-column overflow instead of a lane.
    const laneRanges: [number, number][][] = [];
    const segments: MonthSegment[] = [];
    const overflow = new Array<number>(7).fill(0);
    for (const s of inWeek) {
      let lane = 0;
      while (laneRanges[lane]?.some(([ls, le]) => s.startCol <= le && ls <= s.endCol)) lane += 1;
      let row = laneRanges[lane];
      if (!row) {
        row = [];
        laneRanges[lane] = row;
      }
      row.push([s.startCol, s.endCol]);
      if (lane < visibleLanes) segments.push({ ...s, lane });
      else for (let c = s.startCol; c <= s.endCol; c += 1) overflow[c] = (overflow[c] ?? 0) + 1;
    }
    return { segments, overflow };
  });
}

// ---------------------------------------------------------------------------
// Week + day time-grid (Calendar Views milestone, Branch C). Pure layout for an hour-axis grid: the
// day-key columns of the visible week/day (weekDays), a timed event's vertical placement within one day
// column in minutes-from-midnight (eventDayPlacement, clamped to the day so a block crossing midnight
// renders one piece per day it covers), side-by-side packing of concurrent events (packDayColumns), the
// all-day bar lane (layoutAllDayLane), the current-time line offset (nowIndicatorOffset), and the shared
// per-block accessible name (eventAccessibleName). Timed events are placed by their viewer-zone DISPLAY
// components ({@link displayStartParts}); the same UTC-on-the-parts day math as the rest of the file.
// ---------------------------------------------------------------------------

/** Minutes in a day — the time grid's vertical extent (00:00 → 24:00). */
export const MINUTES_PER_DAY = 1440;

/**
 * The "YYYY-MM-DD" day keys of the week (count 7, Sun-start) or single day (count 1) containing
 * `anchor` — the time-grid's columns. Matches {@link visibleRange}'s week/day window exactly (week =
 * the Sun…Sat around the anchor; day = the anchor's own day), so the rendered columns and the queried
 * window can't diverge (the {@link monthGridBounds} discipline, here for the time grid).
 */
export function weekDays(anchor: Date, count: number): string[] {
  const start = count === 1 ? localMidnight(anchor) : startOfWeek(anchor);
  const out: string[] = [];
  const d = new Date(start);
  for (let i = 0; i < count; i += 1) {
    out.push(localDateKey(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// UTC ms for a DateParts INCLUDING its clock time — the scalar that places a timed event against a day
// column. (The month helpers compare whole days via keyToUtcMs; the time grid needs the wall-clock
// instant.)
function partsUtcMs(p: DateParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** A timed event's vertical placement within ONE day column: `top`/`height` in minutes-from-midnight,
 * clamped to [0, {@link MINUTES_PER_DAY}]. The `event` rides along for packing/rendering. */
export interface DayPlacement {
  event: CalendarEvent;
  top: number;
  height: number;
}

/**
 * Place a TIMED event within the `dayKey` column, or null when it doesn't belong there: an all-day /
 * `showWithoutTime` event (those go to the all-day lane, never the time grid), an unparseable start, or
 * an event that doesn't overlap the day. `top`/`height` are minutes-from-midnight clamped to the day,
 * so a midnight-crossing event yields a block per covered day (e.g. 23:00→01:00 → [1380,1440] on day 1,
 * then [0,60] on day 2). A zero-duration event keeps height 0 (the renderer floors a visible minimum)
 * and still shows on the day its instant falls in. Intervals are half-open: an event ending exactly at
 * a day's 00:00 boundary occupies no time on that later day, so it doesn't render there. Placed by the
 * event's DISPLAY components ({@link displayStartParts} — a tz-bearing event converted to the viewer's
 * zone, a floating event at face value), so the block lands where the viewer sees its time, sharing one
 * frame with the now-indicator (also viewer-zone). Pure.
 */
export function eventDayPlacement(event: CalendarEvent, dayKey: string): DayPlacement | null {
  if (isAllDay(event)) return null;
  const start = displayStartParts(event);
  if (!start) return null;
  const end = displayEndParts(event) ?? start;
  const dayMs = keyToUtcMs(dayKey);
  if (Number.isNaN(dayMs)) return null;
  const startMin = (partsUtcMs(start) - dayMs) / 60_000;
  const endMin = (partsUtcMs(end) - dayMs) / 60_000;
  // Touches this day? A zero-duration event shows when its instant is in [0, day); a positive-length
  // event shows when its half-open [start,end) overlaps [0, day) — exact-touch at a day edge doesn't.
  const touches =
    endMin === startMin
      ? startMin >= 0 && startMin < MINUTES_PER_DAY
      : startMin < MINUTES_PER_DAY && endMin > 0;
  if (!touches) return null;
  const top = Math.max(0, Math.min(MINUTES_PER_DAY, startMin));
  const bottom = Math.max(0, Math.min(MINUTES_PER_DAY, endMin));
  return { event, top, height: Math.max(0, bottom - top) };
}

/** A {@link DayPlacement} assigned a sub-column for side-by-side rendering of concurrent events:
 * `column` (0-based, left→right) of `columns` total in its overlap cluster, so the renderer sets
 * width = 1/`columns` and left = `column`/`columns`. */
export interface PackedPlacement extends DayPlacement {
  column: number;
  columns: number;
}

/**
 * Pack a day column's timed placements into side-by-side sub-columns (the classic interval-graph greedy
 * packing): events are grouped into overlap CLUSTERS (a maximal run of transitively-overlapping events),
 * and within each cluster every event takes the leftmost sub-column free at its start; the cluster's
 * column count (its peak concurrency) is shared by all its members so they tile to full width.
 * Intervals are half-open [top, top+height): exact-touch (one ends where the next starts) does NOT
 * overlap and shares a column. `minHeight` is the renderer's visual floor (a short/zero-duration block
 * is drawn at least this tall): overlap is computed against `max(height, minHeight)` so two events that
 * don't overlap in TIME but WOULD overlap once floored to the minimum still get side-by-side columns —
 * packing then matches what's actually drawn (and two zero-duration events at the same instant tile
 * side-by-side instead of visually colliding). The OUTPUT keeps the true `top`/`height`; the renderer
 * applies the same floor. Deterministic input order — earlier `top`, then taller, then
 * {@link compareEvents} — so the packing is stable across renders. Pure; returns a flat list (the
 * cluster grouping is internal).
 */
export function packDayColumns(
  placements: DayPlacement[],
  minHeight: number = 0,
): PackedPlacement[] {
  const sorted = [...placements].sort(
    (a, b) => a.top - b.top || b.height - a.height || compareEvents(a.event, b.event),
  );
  const result: PackedPlacement[] = [];
  let cluster: PackedPlacement[] = [];
  let colEnds: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flush = () => {
    if (cluster.length === 0) return;
    const columns = colEnds.length;
    for (const p of cluster) p.columns = columns;
    result.push(...cluster);
    cluster = [];
    colEnds = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const p of sorted) {
    // Effective end uses the rendered minimum so packing matches the floored visual height.
    const end = p.top + Math.max(p.height, minHeight);
    // A new cluster begins once this event starts at/after every prior cluster member has ended (no
    // overlap with any — they're start-sorted, so clusterEnd, the running max end, bounds them all).
    if (cluster.length > 0 && p.top >= clusterEnd) flush();
    // Leftmost sub-column whose last event has ended by this event's start (exact-touch frees it).
    let column = colEnds.findIndex((colEnd) => colEnd <= p.top);
    if (column === -1) {
      column = colEnds.length;
      colEnds.push(end);
    } else {
      colEnds[column] = end;
    }
    cluster.push({ ...p, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return result;
}

/** One all-day bar in the week's all-day lane: its clipped column span [startCol,endCol] (0-based within
 * the visible days), `lane` (stacked row), and whether it continues past the visible window (open edges). */
export interface AllDaySegment {
  event: CalendarEvent;
  startCol: number;
  endCol: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Lay the all-day events covering the visible `days` into stacked lanes of clipped bars (the time
 * grid's top all-day lane). ONLY `showWithoutTime` events appear here — timed events (even multi-day
 * ones) render as per-day blocks in the grid via {@link eventDayPlacement}. A bar is clipped to the
 * visible columns and flagged continuesBefore/After when the event extends past them (the {after,before}
 * query returns events overlapping the window). Greedy lane packing — the lowest non-overlapping lane —
 * with the same deterministic order as {@link layoutMonth} (earlier start, longer span, then
 * {@link compareEvents}). Pure; `days` is the {@link weekDays} key list (length 1 or 7).
 */
export function layoutAllDayLane(events: CalendarEvent[], days: string[]): AllDaySegment[] {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return [];
  const firstMs = keyToUtcMs(first);
  const lastMs = keyToUtcMs(last);
  const maxCol = days.length - 1;
  const items = events
    .map((event) => {
      if (!isAllDay(event)) return null;
      const range = eventDayRange(event);
      if (!range || range.lastMs < firstMs || range.firstMs > lastMs) return null;
      return {
        event,
        startCol: Math.max(0, Math.round((range.firstMs - firstMs) / DAY_MS)),
        endCol: Math.min(maxCol, Math.round((range.lastMs - firstMs) / DAY_MS)),
        continuesBefore: range.firstMs < firstMs,
        continuesAfter: range.lastMs > lastMs,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort(
      (a, b) =>
        a.startCol - b.startCol ||
        b.endCol - b.startCol - (a.endCol - a.startCol) ||
        compareEvents(a.event, b.event),
    );
  const laneRanges: [number, number][][] = [];
  const segments: AllDaySegment[] = [];
  for (const s of items) {
    let lane = 0;
    while (laneRanges[lane]?.some(([ls, le]) => s.startCol <= le && ls <= s.endCol)) lane += 1;
    let row = laneRanges[lane];
    if (!row) {
      row = [];
      laneRanges[lane] = row;
    }
    row.push([s.startCol, s.endCol]);
    segments.push({ ...s, lane });
  }
  return segments;
}

/** Minutes-from-midnight for the current-time line on the `dayKey` column, or null when `now`'s LOCAL
 * day isn't that column (only today shows the indicator). Decorative — the renderer marks it
 * aria-hidden. Pure; `now` is a parameter for deterministic tests. */
export function nowIndicatorOffset(now: Date, dayKey: string): number | null {
  if (localDateKey(now) !== dayKey) return null;
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * A self-describing accessible name for an event button in a grid cell/column: title, the cell's day,
 * then the time range. `dayKey` is the CELL/COLUMN's day — NOT necessarily the event's own start day —
 * so a clipped piece of a midnight-crossing block names the day it's drawn on, not where the event
 * began. The time grid is a pointer-centric visual layout (the agenda is the linear accessible
 * equivalent), so each block must name its own day rather than rely on a column-header association.
 */
export function eventAccessibleName(event: CalendarEvent, dayKey: string): string {
  const parts = [eventDisplayTitle(event), formatDayHeading(dayKey)];
  const range = formatTimeRange(event);
  if (range) parts.push(range);
  return parts.join(", ");
}

const FREQ_LABEL: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};
/** Frequency → singular unit ("week"), shared by the recurrence summary badge AND the edit form's
 * interval label so the two can't drift. */
export const FREQ_UNIT: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// Phase 2 — base-event id resolution for the EXPANDED agenda.
//
// The agenda is a `CalendarEvent/query` with `expandRecurrences:true`, so the store is keyed by
// SYNTHETIC per-occurrence ids (even non-recurring events are rewritten — Branch 1 finding). But a
// `CalendarEvent/set update` must target the BASE event id (Stalwart rejects a synthetic id with
// `invalidProperties: "Updating synthetic ids is not yet supported"`), and the synthetic occurrence
// carries `recurrenceId` but NOT `uid` on Stalwart — so there's no explicit base pointer to read.
//
// Probed live (2026-06-17): a synthetic id is `<occurrence-prefix><baseId>` and ALWAYS ends with the
// base id. The prefix is VARIABLE width (5 chars for early occurrences, 6+ for later ones — e.g.
// `eaaaabc`/`baaaaabc` both for base `bc`), so a fixed-width slice would be wrong. Instead resolve by
// matching the LONGEST base id (from a non-expanded `CalendarEvent/query`, which returns base ids)
// that is a suffix of the synthetic id — robust to the variable prefix and to base ids that are
// suffixes of one another. A non-expanded id resolves to itself (it ends with itself).
// ---------------------------------------------------------------------------

/**
 * The base ids that could be the base of `syntheticId` — every id in `baseIds` that is a suffix of it
 * — longest first. `baseIds` must come from a non-expanded `CalendarEvent/query` (the real base ids
 * `CalendarEvent/set` accepts). Usually exactly one matches; MORE than one is possible and ambiguous,
 * because the synthetic prefix is an opaque encoding (probed: it always ends in `a`), so a base id `X`
 * and another base id `aX` (or any longer id ending in `…<prefix-tail>X`) both qualify for an
 * occurrence of `X`. {@link pickBaseEvent} disambiguates by fetching the candidates and matching the
 * viewed occurrence's content.
 */
export function baseEventIdCandidates(syntheticId: string, baseIds: readonly string[]): string[] {
  return baseIds.filter((id) => syntheticId.endsWith(id)).sort((a, b) => b.length - a.length);
}

/**
 * Resolve a (possibly synthetic) event id to its single most-likely BASE event id (the longest base-id
 * suffix), or null. The simple form used where the candidate is unambiguous; the store's edit path
 * uses {@link baseEventIdCandidates} + {@link pickBaseEvent} to disambiguate the rare collision.
 */
export function resolveBaseEventId(syntheticId: string, baseIds: readonly string[]): string | null {
  return baseEventIdCandidates(syntheticId, baseIds)[0] ?? null;
}

/**
 * The newly-appeared agenda occurrence id backing a just-created BASE event, or null — the INVERSE of
 * {@link baseEventIdCandidates}, used to re-point the selection after a create. The agenda is re-queried
 * (synthetic-keyed) after a create, so the base id the server returned isn't itself a store key; the
 * new occurrence is the synthetic id ENDING IN the base id that wasn't present `before` the create
 * (`before` excludes a pre-existing occurrence that coincidentally ends in the new base id — the same
 * `X`-vs-`aX` suffix overlap {@link pickBaseEvent} guards). Returns the single match, or null when there
 * are none (the event was created outside the agenda window) or several (ambiguous) — the caller then
 * clears the selection rather than guess at the wrong event. Pure; the store passes the live ids + set.
 */
export function freshOccurrenceIdForBase(
  baseId: string,
  occurrenceIds: readonly string[],
  before: ReadonlySet<string>,
): string | null {
  const fresh = occurrenceIds.filter((sid) => sid.endsWith(baseId) && !before.has(sid));
  return fresh.length === 1 ? (fresh[0] as string) : null;
}

/**
 * Choose which fetched base event actually backs `occurrence` from the suffix-collision `candidates`.
 * With one candidate it's that one. With several (the `X` vs `aX` ambiguity above) it disambiguates by
 * the occurrence's `title`, then — for a recurring occurrence whose titles still tie — by which base
 * carries a `recurrenceRule`. When NO reliable signal narrows it to exactly one (the occurrence is
 * absent, its title matches none, or several share a title and recurrence can't break the tie) it
 * returns null and FAILS SAFE rather than guessing — the caller then keeps the read-only detail
 * instead of opening the edit form on (and patching) the wrong event/series. Pure; the store fetches
 * the candidate events and passes them here.
 */
export function pickBaseEvent(
  occurrence: CalendarEvent | undefined,
  candidates: CalendarEvent[],
): CalendarEvent | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  // Several suffix-compatible candidates → we need a signal to pick exactly one, or we refuse.
  const title = occurrence?.title;
  const byTitle = title !== undefined ? candidates.filter((c) => c.title === title) : [];
  if (byTitle.length === 1) return byTitle[0] ?? null;
  if (byTitle.length > 1 && occurrence?.recurrenceId) {
    const recurring = byTitle.filter((c) => c.recurrenceRule);
    if (recurring.length === 1) return recurring[0] ?? null;
  }
  return null; // genuinely ambiguous — don't guess
}

/**
 * Whether the event can be edited: at least one calendar it belongs to grants write rights
 * (`myRights.mayWriteAll` or `mayWriteOwn`). The single gate the Edit affordance uses, so an event in
 * only read-only calendars shows no edit UI rather than letting the user hit a server refusal. Gates
 * on the SELECTED (possibly synthetic) event's `calendarIds` — which the expanded occurrence carries,
 * so no base-id resolution is needed just to decide visibility. Mirrors `cardMayWrite`. Reactive
 * callers pass the live `calendars` store. (Branch 4's delete will mirror this on `mayDelete`.)
 */
export function eventMayWrite(event: CalendarEvent, cals: Record<string, Calendar>): boolean {
  return Object.entries(event.calendarIds ?? {}).some(([id, present]) => {
    const rights = present === true ? cals[id]?.myRights : undefined;
    return rights?.mayWriteAll === true || rights?.mayWriteOwn === true;
  });
}

/**
 * Whether the event can be deleted: at least one calendar it belongs to grants `myRights.mayDelete`.
 * The single gate the Delete affordance uses (Branch 4), so an event in only non-deletable calendars
 * shows no delete UI rather than letting the user hit a server refusal. Mirrors {@link eventMayWrite}
 * exactly — same "any calendar grants it" + membership-value-`=== true` shape — but on `mayDelete`.
 * Gates on the SELECTED (possibly synthetic) occurrence's `calendarIds`, which the expanded event
 * carries, so no base-id resolution is needed just to decide visibility. Reactive callers pass the
 * live `calendars` store. (Deleting a recurring event removes the whole series — see `deleteEvent`.)
 */
export function eventMayDelete(event: CalendarEvent, cals: Record<string, Calendar>): boolean {
  return Object.entries(event.calendarIds ?? {}).some(([id, present]) => {
    const rights = present === true ? cals[id]?.myRights : undefined;
    return rights?.mayDelete === true;
  });
}

// ---------------------------------------------------------------------------
// Editable event model — the edit form's working copy of a BASE event, and the pure transforms that
// turn it back into (a) a full event for an optimistic store write and (b) a minimal JSON-pointer
// patch for CalendarEvent/set update. The working copy now ALSO carries recurrence (the rule editor,
// below); participants stay present-but-uneditable — NOT in the working copy and NOT in the rebuilt
// property set, so a patch never names them and they carry through untouched (as the contacts form
// carried `photos`/`kind`).
//
// The governing invariant (carried verbatim from the contacts edit form): open the form and save with
// NO edits ⇒ empty patch / true no-op. Every normalization (trim, duration recompute) runs ONLY on a
// value the user actually changed; an unchanged value is carried VERBATIM. The when-group is the
// subtle case: deriving an end-time from `start + duration` and recomputing `duration` from it is
// LOSSY (e.g. "PT90M" → end → "PT1H30M"), so when the when-fields are unchanged we carry the original
// `start`/`duration`/`timeZone`/`showWithoutTime` verbatim and only recompute when they changed. The
// recurrence rule follows the same lossy-rebuild guard (see the recurrence section).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recurrence RULE editor (Recurrence-Editing milestone, Branch 1). The form's working copy of an
// event's recurrence + the pure transforms between it and a JSCalendar `recurrenceRule`. Like the
// when-fields, the no-op invariant governs: an unchanged recurrence is carried VERBATIM (the original
// rule object), so re-deriving from an untouched event emits no patch — `editableToRule` need not be a
// perfect inverse of `ruleToEditable` (only a CHANGED recurrence is rebuilt). For a CHANGED rule the
// weekly/monthly specifics are derived from the event's START (its weekday / day-of-month), the common
// calendar-UI convention ("Monthly on the 2nd Tuesday").
//
// WIRE NOTE (Fastmail portability): we emit the SINGULAR `recurrenceRule` object — what dev Stalwart
// accepts (it REJECTS the RFC-8984 plural `recurrenceRules` array). The build is isolated in
// `editableToRule` so a spec-strict/Fastmail target (plural array, `excludedRecurrenceRules`) is a
// localized change here, not a rewrite. See [[qelo-calendar-recurrence.md]].
// ---------------------------------------------------------------------------

/** The recurrence frequencies the editor exposes; "" = does not repeat. */
export type EditableFrequency = "" | "daily" | "weekly" | "monthly" | "yearly";

/**
 * The recurrence editor's working copy. `weekdays` are byDay codes (weekly); `monthlyNth` picks the
 * monthly pattern (true = "the Nth <weekday>" via byDay+nthOfPeriod, false = "day N" via byMonthDay) —
 * both derived from the start on write. `end` chooses the termination (`count`/`until` carry their
 * field). A non-recurring event is `frequency: ""`.
 */
export interface EditableRecurrence {
  frequency: EditableFrequency;
  interval: number;
  weekdays: string[];
  monthlyNth: boolean;
  end: "never" | "count" | "until";
  count: number;
  until: string; // "YYYY-MM-DD"
}

// RFC 8984 byDay weekday codes, Sunday-indexed to line up with Date.getUTCDay().
const WEEKDAY_CODES = ["su", "mo", "tu", "we", "th", "fr", "sa"];

function weekdayCode(p: DateParts): string {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return WEEKDAY_CODES[d.getUTCDay()] ?? "su";
}

// Which occurrence of its weekday within the month a date is (1–5) — the `nthOfPeriod` for a monthly
// "Nth <weekday>" rule (e.g. the 15th is in the 3rd week → 3rd <weekday>).
function nthWeekdayOfMonth(p: DateParts): number {
  return Math.floor((p.day - 1) / 7) + 1;
}

/** A blank (non-recurring) recurrence working copy, with sensible defaults for when the user turns
 * repeating on (every 1, end never, a default count of 10 if they switch to "after N"). */
export function emptyRecurrence(): EditableRecurrence {
  return {
    frequency: "",
    interval: 1,
    weekdays: [],
    monthlyNth: false,
    end: "never",
    count: 10,
    until: "",
  };
}

/**
 * Derive the recurrence editor's working copy from an event's `recurrenceRule`. Best-effort: an
 * unknown/absent frequency → non-repeating; `byDay` codes populate `weekdays`; a byDay carrying
 * `nthOfPeriod` flags the monthly "Nth weekday" pattern; `count`/`until` set the end. Pure +
 * deterministic, so re-deriving an unchanged event reproduces identical fields (the no-op foundation).
 *
 * A WEEKLY rule with no `byDay` repeats on the event's start weekday (the server's implicit default),
 * so we surface that day as selected — otherwise the editor would show "weekly" with no day checked,
 * contradicting what the rule actually does. The verbatim-carry guard keeps this from emitting a
 * spurious byDay on an untouched save (both sides of recurrenceChanged seed the same day).
 */
export function ruleToEditable(event: CalendarEvent): EditableRecurrence {
  const e = emptyRecurrence();
  const rule = event.recurrenceRule;
  const freq = rule?.frequency?.toLowerCase();
  if (!freq || !["daily", "weekly", "monthly", "yearly"].includes(freq)) return e;
  e.frequency = freq as EditableFrequency;
  e.interval = rule?.interval && rule.interval > 1 ? rule.interval : 1;
  e.weekdays = (rule?.byDay ?? [])
    .map((d) => d.day?.toLowerCase())
    .filter((d): d is string => Boolean(d));
  if (e.frequency === "weekly" && e.weekdays.length === 0) {
    const start = eventStartParts(event);
    if (start) e.weekdays = [weekdayCode(start)];
  }
  e.monthlyNth = (rule?.byDay ?? []).some((d) => typeof d.nthOfPeriod === "number");
  if (typeof rule?.count === "number") {
    e.end = "count";
    e.count = rule.count;
  } else if (rule?.until) {
    e.end = "until";
    e.until = rule.until.slice(0, 10);
  }
  return e;
}

/**
 * Build a JSCalendar `recurrenceRule` from the editor's working copy, or undefined when not repeating.
 * Weekly carries the chosen `weekdays` (byDay); monthly derives the pattern from `start` (Nth weekday
 * vs day-of-month); `count`/`until` set the termination (a timed `until` takes the start's time-of-day
 * so the last occurrence is included). Only called for a CHANGED recurrence (an unchanged one is carried
 * verbatim) — so it needn't reproduce an arbitrary server rule byte-for-byte. Pure.
 */
export function editableToRule(
  rec: EditableRecurrence,
  start: DateParts | null,
): RecurrenceRule | undefined {
  if (rec.frequency === "") return undefined;
  const rule: RecurrenceRule = { "@type": "RecurrenceRule", frequency: rec.frequency };
  if (rec.interval > 1) rule.interval = rec.interval;
  if (rec.frequency === "weekly" && rec.weekdays.length > 0) {
    rule.byDay = rec.weekdays.map((day): NDay => ({ "@type": "NDay", day }));
  } else if (rec.frequency === "monthly" && start) {
    if (rec.monthlyNth) {
      // The 5th occurrence of a weekday doesn't exist in every month; emit -1 ("the last <weekday>")
      // so the series doesn't silently skip the short months (the common calendar-UI convention).
      const nth = nthWeekdayOfMonth(start);
      rule.byDay = [{ "@type": "NDay", day: weekdayCode(start), nthOfPeriod: nth >= 5 ? -1 : nth }];
    } else {
      rule.byMonthDay = [start.day];
    }
  }
  if (rec.end === "count" && rec.count >= 1) {
    rule.count = rec.count;
  } else if (rec.end === "until" && rec.until) {
    const time = start
      ? `${pad2(start.hour)}:${pad2(start.minute)}:${pad2(start.second)}`
      : "00:00:00";
    rule.until = `${rec.until}T${time}`;
  }
  return rule;
}

// Whether the user changed the recurrence vs the baseline's derived editable. Drives "carry the
// original rule verbatim" (unchanged) vs "rebuild from the editor" (changed) — the same lossy-rebuild
// guard the when-fields use, so the no-op invariant holds regardless of editableToRule's fidelity.
// Compares ONLY the fields semantically active for the current mode (the same ones editableToRule
// reads), so fiddling an inactive field and reverting — e.g. setting an Occurrences count then
// switching End back to "Never" — stays a no-op instead of forcing a rebuild. Field-wise (like
// whenChanged), not JSON.stringify, and the weekday SET is compared order-insensitively.
export function recurrenceChanged(baseline: CalendarEvent, edits: EditableEvent): boolean {
  const b = ruleToEditable(baseline);
  const e = edits.recurrence;
  if (b.frequency !== e.frequency) return true;
  if (b.frequency === "") return false; // not repeating → no other field is active
  if (b.interval !== e.interval) return true;
  if (b.frequency === "weekly" && sortedJoin(b.weekdays) !== sortedJoin(e.weekdays)) return true;
  if (b.frequency === "monthly" && b.monthlyNth !== e.monthlyNth) return true;
  if (b.end !== e.end) return true;
  if (b.end === "count" && b.count !== e.count) return true;
  if (b.end === "until" && b.until !== e.until) return true;
  return false;
}

const sortedJoin = (xs: string[]): string => xs.slice().sort().join(",");

/** Whether the recurrence working copy is internally valid: a positive interval, and (when chosen) a
 * positive count or a parseable until date. A non-repeating recurrence is always valid. Pure. */
export function recurrenceValid(rec: EditableRecurrence): boolean {
  if (rec.frequency === "") return true;
  if (!(rec.interval >= 1)) return false;
  if (rec.end === "count" && !(rec.count >= 1)) return false;
  if (rec.end === "until" && parseDateParts(rec.until) === null) return false;
  return true;
}

/** The byDay weekday code (`mo`/`tu`/…) for the form's current start, or "" when unparseable. The
 * weekly picker seeds this when the user first turns repeating on, so the checked day matches what an
 * empty-byDay weekly rule actually does (repeat on the start's weekday) rather than showing none. */
export function startWeekdayCode(edits: EditableEvent): string {
  const p = partsFromInput(edits.start, edits.allDay);
  return p ? weekdayCode(p) : "";
}

const RECURRENCE_ERROR =
  "Enter a valid repeat: an interval of 1 or more, a positive count, or a valid end date.";

/**
 * The edit form's working copy of a base event: every editable property as a flat shape. Dates are
 * the literal `<input>` values — `"YYYY-MM-DD"` (all-day) or `"YYYY-MM-DDTHH:mm"` (timed,
 * `datetime-local`) — interpreted in the event's own `timeZone` (no UTC conversion). `location` is
 * the first location's name (a single-line editor, like the contacts postal `full`); other locations
 * and any other location sub-fields carry through untouched. The enum scalars use `""` for "unset"
 * (the server default), distinct from an explicit value.
 */
export interface EditableEvent {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  status: string;
  freeBusyStatus: string;
  privacy: string;
  recurrence: EditableRecurrence;
}

function dateInput(p: DateParts): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function dateTimeInput(p: DateParts): string {
  return `${dateInput(p)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** The first location's name (insertion order), or "" — the single leaf the form edits. */
function firstLocationName(event: CalendarEvent): string {
  for (const loc of Object.values(event.locations ?? {})) {
    if (loc) return loc.name ?? "";
  }
  return "";
}

/**
 * Derive the form's working copy from a base event. Pure + deterministic, so re-deriving from an
 * unchanged event reproduces identical field values — the foundation of the no-op invariant (a
 * round-trip `eventToEditable` → save with no edits emits an empty patch).
 */
export function eventToEditable(event: CalendarEvent): EditableEvent {
  const allDay = isAllDay(event);
  const start = eventStartParts(event);
  const end = eventEndParts(event) ?? start;
  return {
    title: event.title ?? "",
    description: event.description ?? "",
    location: firstLocationName(event),
    allDay,
    // All-day end is exclusive of the last date (P1D = one day), so show the INCLUSIVE last day —
    // matching formatTimeRange. Timed events show the wall-clock end.
    start: start ? (allDay ? dateInput(start) : dateTimeInput(start)) : "",
    end: end ? (allDay ? dateInput(stepDays(end, -1)) : dateTimeInput(end)) : "",
    timeZone: event.timeZone ?? "",
    status: event.status ?? "",
    freeBusyStatus: event.freeBusyStatus ?? "",
    privacy: event.privacy ?? "",
    recurrence: ruleToEditable(event),
  };
}

function partsFromInput(value: string, allDay: boolean): DateParts | null {
  // A date input is "YYYY-MM-DD"; a datetime-local input is "YYYY-MM-DDTHH:mm" (no seconds). Normalize
  // to what parseDateParts accepts (which range-validates by round-tripping through Date.UTC).
  return parseDateParts(allDay ? value : value.length === 16 ? `${value}:00` : value);
}

function utcMs(p: DateParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// Format a positive millisecond span as an ISO-8601 time duration ("PT1H30M"). Only ever called on a
// when the user CHANGED, so it need not reproduce the server's original duration string verbatim (an
// unchanged when carries the original through untouched) — it just has to be a valid round-trippable
// duration.
function formatMsDuration(ms: number): string | undefined {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds <= 0) return undefined;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;
}

/** The four JSCalendar temporal properties a {@link EditableEvent}'s when-fields map to. `start` is
 * optional so the unchanged path can carry a startless baseline's `start` (undefined) through verbatim,
 * keeping the no-op invariant; editableWhen always produces a concrete start. */
interface WhenProps {
  start: string | undefined;
  duration: string | undefined;
  timeZone: string | null | undefined;
  showWithoutTime: true | undefined;
}

/**
 * Compute the JSCalendar temporal properties (`start`/`duration`/`timeZone`/`showWithoutTime`) from
 * the form's when-fields, or null when invalid (unparseable, or end before start). All-day → a
 * `T00:00:00` start, a `P{n}D` inclusive-day duration, and a null `timeZone`; timed → a wall-clock
 * start, a `PT…` duration (omitted when zero-length), and the chosen tz (null when floating). Pure.
 */
export function editableWhen(edits: EditableEvent): WhenProps | null {
  const start = partsFromInput(edits.start, edits.allDay);
  if (!start) return null;
  const end = partsFromInput(edits.end, edits.allDay);
  if (!end) return null;
  if (edits.allDay) {
    // Inclusive last day → exclusive duration is +1 day. End before start is invalid.
    const days = Math.round((utcMs(end) - utcMs(start)) / 86_400_000) + 1;
    if (days < 1) return null;
    return {
      start: `${dateInput(start)}T00:00:00`,
      duration: `P${days}D`,
      timeZone: null,
      showWithoutTime: true,
    };
  }
  const ms = utcMs(end) - utcMs(start);
  if (ms < 0) return null;
  return {
    start: dateTimeInput(start).replace(/T(\d{2}:\d{2})$/, "T$1:00"),
    duration: formatMsDuration(ms),
    timeZone: edits.timeZone.trim() || null,
    showWithoutTime: undefined,
  };
}

// Whether the user changed any when-field versus the baseline's derived editable form. Used to decide
// "carry the original temporal props verbatim" (unchanged — preserves the exact duration string) vs
// "recompute from the inputs" (changed) — the lossy-duration guard.
function whenChanged(baseline: CalendarEvent, edits: EditableEvent): boolean {
  const b = eventToEditable(baseline);
  return (
    edits.allDay !== b.allDay ||
    edits.start !== b.start ||
    edits.end !== b.end ||
    edits.timeZone !== b.timeZone
  );
}

// Trim/normalize a scalar ONLY when the user changed it; otherwise carry the original verbatim (which
// may be undefined). A changed-to-blank value removes the property (undefined). This keeps an
// untouched title/description/status out of the patch even if it had odd whitespace.
function rebuildScalar(editValue: string, original: string | undefined): string | undefined {
  if (editValue === (original ?? "")) return original;
  const trimmed = editValue.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Rebuild the `locations` map from the single editable name. Unchanged (the edited name still equals
// the first location's name) → carry the original map verbatim, preserving every location and every
// non-name sub-field. Changed → set the first location's name in place (keeping its `@type`/other
// fields and any other locations); a cleared name drops only the name leaf, and the whole location
// only if name was its sole field; a name added where there was none creates a fresh location.
function rebuildLocations(
  editValue: string,
  original: Record<string, EventLocation> | undefined,
): Record<string, EventLocation> | undefined {
  const entries = Object.entries(original ?? {});
  // The form edits the FIRST TRUTHY location (matching firstLocationName, which seeds the editable) —
  // not blindly entries[0], which could be a null/empty map value and desync the no-op comparison.
  const firstKey = entries.find(([, v]) => Boolean(v))?.[0];
  const firstLoc = firstKey ? original?.[firstKey] : undefined;
  if (editValue === (firstLoc?.name ?? "")) return original;
  const value = editValue.trim();
  const out: Record<string, EventLocation> = {};
  for (const [k, v] of entries) {
    if (k === firstKey) {
      if (value === "") {
        // Clear just the name leaf; keep the entry only if it has other fields.
        const kept = { ...(v ?? {}) };
        delete (kept as { name?: string }).name;
        if (Object.keys(kept).length > 0) out[k] = kept as EventLocation;
      } else {
        out[k] = { ...(v ?? {}), name: value };
      }
    } else if (v) {
      out[k] = v; // preserve every other (truthy) location verbatim
    }
  }
  if (!firstKey && value !== "") out.l1 = { "@type": "Location", name: value };
  return Object.keys(out).length > 0 ? out : undefined;
}

// The editable properties rebuilt back into their JSCalendar shapes (undefined = property removed).
// One source of truth so the optimistic event and the patch can't drift. recurrenceRule IS rebuilt
// here (carried verbatim when unchanged); participants/keywords/color/uid/calendarIds are absent →
// never touched → carried through.
interface RebuiltEventProps {
  title: string | undefined;
  description: string | undefined;
  locations: Record<string, EventLocation> | undefined;
  status: string | undefined;
  freeBusyStatus: string | undefined;
  privacy: string | undefined;
  start: string | undefined;
  duration: string | undefined;
  timeZone: string | null | undefined;
  showWithoutTime: true | undefined;
  recurrenceRule: RecurrenceRule | undefined;
}

// Caller MUST ensure the when is valid (editableEventError === null) before rebuilding a CHANGED
// when; on the unchanged path the original temporal props are carried verbatim regardless.
function rebuildEvent(baseline: CalendarEvent, edits: EditableEvent): RebuiltEventProps {
  // The baseline's temporal props carried VERBATIM (start included — a startless baseline carries
  // `undefined`, not `""`, so an untouched startless event emits no spurious `start` patch). Used both
  // for the unchanged-when path and as the (form/store-gated, so unreachable) invalid-when fallback.
  const carryVerbatim: WhenProps = {
    start: baseline.start,
    duration: baseline.duration,
    timeZone: baseline.timeZone,
    showWithoutTime: baseline.showWithoutTime ? true : undefined,
  };
  const when: WhenProps = whenChanged(baseline, edits)
    ? (editableWhen(edits) ?? carryVerbatim)
    : carryVerbatim;
  // Recurrence: carry the baseline rule VERBATIM when unchanged (preserves a server rule the editor
  // can't represent exactly — the no-op guard); rebuild from the editor when changed, anchoring the
  // weekly/monthly specifics on the event's (possibly edited) start.
  const recurrenceRule = recurrenceChanged(baseline, edits)
    ? editableToRule(
        edits.recurrence,
        partsFromInput(edits.start, edits.allDay) ?? eventStartParts(baseline),
      )
    : baseline.recurrenceRule;
  return {
    title: rebuildScalar(edits.title, baseline.title),
    description: rebuildScalar(edits.description, baseline.description),
    locations: rebuildLocations(edits.location, baseline.locations),
    status: rebuildScalar(edits.status, baseline.status),
    freeBusyStatus: rebuildScalar(edits.freeBusyStatus, baseline.freeBusyStatus),
    privacy: rebuildScalar(edits.privacy, baseline.privacy),
    start: when.start,
    duration: when.duration,
    timeZone: when.timeZone,
    showWithoutTime: when.showWithoutTime,
    recurrenceRule,
  };
}

const WHEN_ERROR = "Enter a valid start and end; the end can't be before the start.";

/**
 * The WHEN-field validation message, or null when valid. With a `baseline` (edit) only a CHANGED when
 * is flagged (an unchanged event loaded from the server is always valid — opening + saving without
 * touching the time never blocks); without one (create) any invalid when is flagged. Field-scoped so
 * the form can show it under the date fields independently of the recurrence error (and they can both
 * surface at once). Pure.
 */
export function whenErrorMessage(
  baseline: CalendarEvent | null,
  edits: EditableEvent,
): string | null {
  const validate = baseline ? whenChanged(baseline, edits) : true;
  return validate && editableWhen(edits) === null ? WHEN_ERROR : null;
}

/**
 * The RECURRENCE validation message, or null when valid. Change-gated for edit (an event that loaded
 * with an exotic rule stays savable until the user touches the repeat) and unconditional for create —
 * the SAME gating as {@link whenErrorMessage}, so the displayed error and the Save gate (which is built
 * from these) can't disagree. Field-scoped for the recurrence block. Pure.
 */
export function recurrenceErrorMessage(
  baseline: CalendarEvent | null,
  edits: EditableEvent,
): string | null {
  const validate = baseline ? recurrenceChanged(baseline, edits) : true;
  return validate && !recurrenceValid(edits.recurrence) ? RECURRENCE_ERROR : null;
}

/**
 * The combined edit-form validation message (when, then recurrence), or null. The store boundary
 * ({@link saveEvent}) gates on this; the form shows each part in its own place via the two field-scoped
 * helpers above. Only flags what the user CHANGED (the no-op invariant).
 */
export function editableEventError(baseline: CalendarEvent, edits: EditableEvent): string | null {
  return whenErrorMessage(baseline, edits) ?? recurrenceErrorMessage(baseline, edits);
}

/** The combined CREATE-form validation message (when, then recurrence), or null. A create has no
 * baseline to carry through, so both parts validate outright. */
export function createEventError(edits: EditableEvent): string | null {
  return whenErrorMessage(null, edits) ?? recurrenceErrorMessage(null, edits);
}

/**
 * Apply the form's working copy onto the base event, producing the full event for an OPTIMISTIC store
 * write. Properties the form doesn't expose (participants, keywords, color, uid, calendarIds, …) are
 * carried through untouched; an emptied editable property is removed; the recurrence rule is rebuilt
 * (or carried verbatim when unchanged).
 */
export function editableToEvent(baseline: CalendarEvent, edits: EditableEvent): CalendarEvent {
  const next = { ...baseline };
  const view = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(rebuildEvent(baseline, edits))) {
    if (value === undefined) delete view[key];
    else view[key] = value;
  }
  return next;
}

/**
 * Build the MINIMAL `CalendarEvent/set update` patch from the form's working copy: a whole-property
 * JSON pointer per editable property that actually changed (deep-compared against the baseline), set
 * to its rebuilt value or `null` to remove it (e.g. turning a repeat off emits `recurrenceRule: null`).
 * Unchanged properties — and every property the form doesn't expose (participants, …) — are absent, so
 * the patch never rewrites or clobbers them. An all-unchanged edit yields `{}` (a no-op for the store).
 */
export function editableToPatch(baseline: CalendarEvent, edits: EditableEvent): CalendarEventPatch {
  const patch: CalendarEventPatch = {};
  const original = baseline as unknown as Record<string, unknown>;
  for (const [key, rebuilt] of Object.entries(rebuildEvent(baseline, edits))) {
    // Stable deep compare: an untouched property serializes identically (the unchanged paths return
    // the baseline's own values), so it stays out of the patch.
    if (JSON.stringify(original[key] ?? null) === JSON.stringify(rebuilt ?? null)) continue;
    patch[key] = rebuilt ?? null;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Per-occurrence EDIT modes (Recurrence-Editing milestone, Branch 2). When SAVING an edit to a
// recurring event the user picks how widely it applies; the store routes to one of these pure
// transforms (the form stays seeded from the BASE/series-master event, so "all" is the existing
// editableToPatch path and a no-op stays a no-op):
//   - "all"        → editableToPatch(base, edits): the whole-series patch (the Branch-1 path).
//   - "this"       → overridePatch: the user's delta written into recurrenceOverrides[recurrenceId]
//                    on the BASE id (a WHOLE-MAP merge write — pointer-into-map is rejected; the
//                    server merges so we needn't read existing overrides).
//   - "following"  → splitSeries: cap the base rule's `until` before the split + create a tail event
//                    carrying the remaining rule and the forward edits.
//
// LIVE-PROBED Stalwart quirks these encode (dev v0.16, 2026-06-18 — the milestone plan has the full
// findings):
//   * An overridden occurrence is DROPPED from the expandRecurrences expansion UNLESS its override
//     PatchObject carries a `title` — so overridePatch ALWAYS carries the (possibly unchanged) title.
//     With a title present, every override round-trips AND a per-occurrence `start` MOVES correctly.
//   * `until` is compared DATE-inclusively (a `splitStart − 1s` cap kept the whole split day, leaving
//     the split occurrence in BOTH head and tail) — so the head caps at `splitStart − 1 DAY`, which
//     keeps the prior occurrence and excludes the split for every editor frequency (≥ 1-day spacing).
//   * relatedTo split-LINKING is infeasible (uid unreadable) → the tail is an UNLINKED standalone
//     event; functional, the next/first link is deferred (see types `Relation`).
// ---------------------------------------------------------------------------

/** How widely a save to a recurring event applies. A non-recurring event always uses "all". */
export type RecurrenceEditMode = "this" | "following" | "all";

/** How widely a DELETE of a recurring event applies (mirrors {@link RecurrenceEditMode}): "this" =
 * exclude just the clicked occurrence; "following" = drop the clicked occurrence and every one after
 * it (cap the series); "all" = destroy the whole series. A non-recurring event always uses "all". */
export type RecurrenceDeleteMode = "this" | "following" | "all";

// The local date-time one day before `dt` (keeping its time-of-day), as a JSCalendar LocalDateTime —
// the head's capped `until` for a split (Stalwart keeps the whole until-date, so a full day back
// excludes the split occurrence while keeping the prior one). Returns `dt` unchanged if unparseable.
function minusOneDayLocalDateTime(dt: string): string {
  const p = parseDateParts(dt);
  if (!p) return dt;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day) - DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/**
 * The "this occurrence" override: the user's delta (vs the form's BASE baseline) written as a
 * JSCalendar PatchObject under `recurrenceOverrides[recurrenceId]` (a whole-map merge write on the
 * base id). Returns null when there's nothing to override on ONE occurrence — i.e. nothing changed, OR
 * the ONLY change was the `recurrenceRule` (a single occurrence can't carry its own rule, so the rule
 * is dropped from the delta BEFORE the emptiness check). So a null result is NOT a guaranteed full no-op
 * — the caller (`saveEvent`) degrades a null override to the whole-series patch. `recurrenceRule` is
 * never overridden per-occurrence. The override ALWAYS carries a `title` (the Stalwart
 * visibility workaround above) — the changed title if edited, else the baseline's, so the override
 * never strips the occurrence out of the expansion. Since the form is base-seeded, a `start` in the
 * delta moves the occurrence to exactly the date/time the form showed (WYSIWYG); the form opening on
 * the series' first-occurrence date — rather than the clicked occurrence's date — is a documented
 * limitation (occurrence-date seeding is a deferred follow-up). Pure.
 */
export function overridePatch(
  recurrenceId: string,
  baseline: CalendarEvent,
  edits: EditableEvent,
): CalendarEventPatch | null {
  const delta = editableToPatch(baseline, edits);
  delete delta.recurrenceRule; // a per-occurrence override can't change the series rule
  if (Object.keys(delta).length === 0) return null; // nothing changed → no override to write
  // Carry a title KEY so Stalwart keeps the occurrence in the expansion. Probed live: an ABSENT title
  // key drops the occurrence, but an empty-string value does NOT — so the `?? ""` fallback (for a
  // titleless baseline) is safe and keeps the occurrence visible with a blank title. A title-removing
  // `null` from the delta is replaced with the baseline title (else the key would carry null).
  if (typeof delta.title !== "string") {
    delta.title = baseline.title ?? "";
  }
  return { recurrenceOverrides: { [recurrenceId]: delta } };
}

/** The two writes a "this and following" split issues in ONE CalendarEvent/set: a patch capping the
 * base (head) series and a create body for the tail series. */
export interface SeriesSplit {
  basePatch: CalendarEventPatch;
  tailCreate: Record<string, unknown>;
}

/**
 * Cap a recurring series to END before `recurrenceId`: the base's original rule with `count` dropped
 * and `until` set to one day before the split occurrence (the date-inclusive cap — Stalwart keeps the
 * whole until-date, so a full day back excludes the split occurrence while keeping the prior one;
 * `@type` is re-asserted since the server strips it on read). Returns the `{ recurrenceRule }` patch,
 * or null when the base isn't a recurring series (no rule to cap). The SINGLE source of the
 * head-cap, shared by {@link splitSeries} (the "this and following" EDIT, which also creates a tail)
 * and the "this and following" DELETE (which caps WITHOUT a tail — the split occurrence and everything
 * after it are simply removed). Pure.
 */
export function truncateSeriesBefore(
  baseline: CalendarEvent,
  recurrenceId: string,
): CalendarEventPatch | null {
  const baseRule = baseline.recurrenceRule;
  if (!baseRule) return null;
  const headRule: RecurrenceRule = {
    ...baseRule,
    "@type": "RecurrenceRule",
    until: minusOneDayLocalDateTime(recurrenceId),
  };
  delete headRule.count;
  return { recurrenceRule: headRule };
}

/**
 * The "this occurrence" DELETE: an `excluded:true` exception written under
 * `recurrenceOverrides[recurrenceId]` (RFC 8984 §4.3.6) — a whole-map merge write on the base id that
 * drops JUST this occurrence from the expansion, leaving the rest of the series intact. Unlike
 * {@link overridePatch}, it carries NO `title`: the title key is the Stalwart workaround for keeping an
 * EDITED occurrence VISIBLE, but an excluded occurrence is meant to VANISH, and `excluded` is the only
 * key the exception needs (probed live, Branch 2). A non-destructive `set update` on the base — the
 * series object survives. Pure.
 */
export function excludeOverride(recurrenceId: string): CalendarEventPatch {
  return { recurrenceOverrides: { [recurrenceId]: { excluded: true } } };
}

/**
 * The "this and following" split (RFC 8984 §4.1.3 — there is no native "this and future", every
 * conformant client splits the series). The HEAD (the base event) is capped to end before the split
 * occurrence; a new TAIL event carries the occurrences from the split onward with the user's forward
 * edits. Returns null when the base isn't a recurring series (no rule to cap) — the caller falls back
 * to a plain "all" save.
 *
 *  - HEAD: the base's ORIGINAL rule with `count` dropped and `until` set to one day before the split
 *    (the date-inclusive cap above) — past occurrences keep their original pattern, the split + after
 *    are excluded.
 *  - TAIL: the base event with the user's edits overlaid ({@link editableToEvent}), restarted at the
 *    split occurrence's date (keeping the possibly-edited time-of-day), carrying the remaining rule
 *    (the EDITED rule when the user changed how it repeats, else the original verbatim). Server-managed
 *    / occurrence-specific fields (id, uid, recurrenceId, recurrenceOverrides, relatedTo, …) are
 *    stripped so it's a clean create. The tail is UNLINKED (no relatedTo — uid unreadable on Stalwart);
 *    a count-bounded original makes the tail re-count its full `count` from the split (the exact
 *    remaining-count needs client-side recurrence enumeration, which we avoid — a documented tradeoff).
 * Pure.
 */
export function splitSeries(
  baseline: CalendarEvent,
  recurrenceId: string,
  edits: EditableEvent,
): SeriesSplit | null {
  // Head: the base's original rule capped to end before the split ({@link truncateSeriesBefore} owns
  // the −1-day cap + count drop). Null means a non-recurring base — nothing to split.
  const basePatch = truncateSeriesBefore(baseline, recurrenceId);
  if (!basePatch) return null;

  // Tail: the fully-edited event, restarted at the split with the remaining rule.
  const edited = editableToEvent(baseline, edits);
  const tail = { ...edited } as Record<string, unknown>;
  for (const k of [
    "id",
    "uid",
    "recurrenceId",
    "recurrenceIdTimeZone",
    "recurrenceOverrides",
    "relatedTo",
    "isOrigin",
    "isDraft",
    "updated",
  ]) {
    delete tail[k];
  }
  // Restart at the split occurrence's DATE, keeping the (possibly edited) time-of-day from the rebuild.
  const editedStart = edited.start ?? baseline.start ?? recurrenceId;
  const timeOfDay = editedStart.length >= 19 ? editedStart.slice(11, 19) : "00:00:00";
  tail.start = `${recurrenceId.slice(0, 10)}T${timeOfDay}`;
  // The remaining rule rides along from `edited` (via the {@link tail} spread): the EDITED rule when the
  // user changed the repeat, the base rule VERBATIM when untouched, or ABSENT when the user turned the
  // repeat OFF (editableToEvent drops the key) — then the tail is a single non-recurring event. Only
  // re-assert `@type` (stripped on read) when a rule is actually present; never re-add the base rule.
  if (tail.recurrenceRule) {
    tail.recurrenceRule = { "@type": "RecurrenceRule", ...(tail.recurrenceRule as RecurrenceRule) };
  }
  return { basePatch, tailCreate: tail };
}

/**
 * The id of the loaded occurrence whose `recurrenceId` matches `recurrenceId`, or null. Re-points the
 * selection after a per-occurrence save: an override reshuffles the synthetic occurrence ids, so we
 * re-find the occurrence by its recurrenceId rather than the now-stale synthetic id. BEST-EFFORT —
 * Stalwart reports an occurrence's `recurrenceId` as its RESOLVED start (probed live), so a match
 * succeeds only when the occurrence's TIME did NOT move; a time move / split re-times the occurrence
 * (its recurrenceId becomes the new start), so the original recurrenceId no longer matches and this
 * returns null. Also null when none match (occurrence left the window) or several do (ambiguous). The
 * caller treats null as "clear the selection" rather than guess. Pure; the store passes the live ids +
 * event lookup.
 */
export function occurrenceIdByRecurrenceId(
  recurrenceId: string,
  ids: readonly string[],
  events: Record<string, CalendarEvent | undefined>,
): string | null {
  const matches = ids.filter((id) => events[id]?.recurrenceId === recurrenceId);
  return matches.length === 1 ? (matches[0] as string) : null;
}

// ---------------------------------------------------------------------------
// Create — a NEW event from a blank working copy, reusing the same rebuildEvent as the edit path so
// the two transforms can't drift. The create form exposes the SAME editable set as edit (title, when,
// location, description, status/free-busy/privacy, AND the recurrence rule — a new event can be made
// recurring); participants are NOT settable (no field, and Stalwart drops them on create anyway —
// probed live), so they're absent from the body. The server assigns `uid` and the id.
// ---------------------------------------------------------------------------

// The rebuild "original" for a create: an Event with no editable props set, so rebuildEvent treats
// every form value as new (no verbatim carry-through). `{ "@type": "Event" }` typed as CalendarEvent
// reads only its (all-undefined) optional props here — a deliberate, contained cast.
const EMPTY_EVENT = { "@type": "Event" } as CalendarEvent;

/**
 * A blank working copy for the create form, pre-seeded with a sensible default slot — the next top of
 * the hour, one hour long, timed (not all-day), floating time zone — so the form opens with a VALID
 * when and the user typically only types a title (the new-event minimum is a title + a start). Built
 * in LOCAL wall-clock terms to match the `datetime-local` input shape; `now` is a parameter so tests
 * are deterministic. The {@link editableHasContent} gate still blocks a save until a title is entered.
 */
export function emptyEditableEvent(now: Date = new Date()): EditableEvent {
  const startD = new Date(now);
  startD.setMinutes(0, 0, 0);
  startD.setHours(startD.getHours() + 1);
  const endD = new Date(startD);
  endD.setHours(endD.getHours() + 1);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(
      d.getMinutes(),
    )}`;
  return {
    title: "",
    description: "",
    location: "",
    allDay: false,
    start: fmt(startD),
    end: fmt(endD),
    timeZone: "",
    status: "",
    freeBusyStatus: "",
    privacy: "",
    recurrence: emptyRecurrence(),
  };
}

/**
 * Whether the working copy is worth creating: a non-blank title AND a valid when (both dates parse
 * and the end isn't before the start). The create form gates Save on this and {@link createEvent}
 * re-checks it at the store boundary (enforcement isn't just the UI) — the create-form analog of the
 * edit path's empty-patch no-op. A blank or whitespace-only title, or an invalid when, isn't a
 * savable event.
 */
export function editableHasContent(edits: EditableEvent): boolean {
  return edits.title.trim() !== "" && editableWhen(edits) !== null;
}

/**
 * Build the `CalendarEvent/set create` body from the form's working copy: `@type` + the chosen
 * `calendarIds` plus every editable property that survives the rebuild (blanks dropped) — including a
 * `recurrenceRule` when the editor set one. No `id` or `uid` — the server assigns both (a client-chosen
 * uid buys nothing here and risks a collision on a duplicate create). Participants are absent (not
 * exposed). Same {@link rebuildEvent} as the edit/patch transforms, so they can't drift. Caller MUST
 * ensure {@link editableHasContent}.
 */
export function createEventBody(
  edits: EditableEvent,
  calendarIds: Record<string, true>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { "@type": "Event", calendarIds };
  for (const [key, value] of Object.entries(rebuildEvent(EMPTY_EVENT, edits))) {
    if (value !== undefined) body[key] = value;
  }
  return body;
}

/**
 * Seed a full local {@link CalendarEvent} for the optimistic store write after a create: the
 * structural fields under the server-assigned `id` + calendar membership, with the form's edits
 * overlaid. Gives the new event an instant render before the reconcile re-query absorbs server truth.
 * Same {@link rebuildEvent} (via {@link editableToEvent}) as {@link createEventBody}, so they agree.
 */
export function createdEventFor(
  id: string,
  edits: EditableEvent,
  calendarIds: Record<string, true>,
): CalendarEvent {
  const seed = { "@type": "Event", id, calendarIds } as unknown as CalendarEvent;
  return editableToEvent(seed, edits);
}

/**
 * The calendars this account can create an event in: at least one of `mayWriteAll`/`mayWriteOwn`,
 * sorted for the picker (default first, then sortOrder/name). The "+ New event" affordance is gated
 * on this being non-empty; the create form's calendar picker lists them (and skips the picker when
 * there's exactly one). Mirrors `writableBooks`.
 */
export function writableCalendars(cals: Record<string, Calendar>): Calendar[] {
  return Object.values(cals)
    .filter((c) => c.myRights.mayWriteAll === true || c.myRights.mayWriteOwn === true)
    .sort(compareCalendars);
}

/** The default destination among writable `cals` (already filtered/sorted by {@link writableCalendars}):
 * the server-default calendar if it's writable, else the first. Null only when there are none. */
export function defaultWritableCalendarId(cals: Calendar[]): string | null {
  return (cals.find((c) => c.isDefault) ?? cals[0])?.id ?? null;
}
