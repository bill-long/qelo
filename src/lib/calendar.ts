// Pure helpers for the read-only calendar view: parse a JSCalendar event's local date-time + ISO-8601
// duration, format the time range / day heading, group events into agenda day buckets, and summarize a
// recurrence rule in prose. No SolidJS, no JMAP client — data → data, unit-tested in isolation.
//
// JSCalendar (RFC 8984) `start` is a LOCAL date-time string (no `Z`/offset) interpreted in the event's
// `timeZone`; an all-day event is `showWithoutTime` with a date-valued `duration`. We deliberately do
// NOT push these through `new Date(string)` (which would apply the runtime's timezone and shift the
// wall-clock value) — we parse the components verbatim and only use UTC date math (Date.UTC) so the
// displayed day/time matches what the server sent, regardless of where the client runs.

import type { CalendarEventPatch } from "@/jmap/methods";
import type { Calendar, CalendarEvent, EventLocation, RecurrenceRule } from "@/jmap/types";

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
// patch for CalendarEvent/set update. Recurrence + participants are present-but-uneditable: they're
// NOT in the working copy and NOT in the rebuilt property set, so a patch never names them and they
// carry through untouched (the same way the contacts form carried `photos`/`kind`).
//
// The governing invariant (carried verbatim from the contacts edit form): open the form and save with
// NO edits ⇒ empty patch / true no-op. Every normalization (trim, duration recompute) runs ONLY on a
// value the user actually changed; an unchanged value is carried VERBATIM. The when-group is the
// subtle case: deriving an end-time from `start + duration` and recomputing `duration` from it is
// LOSSY (e.g. "PT90M" → end → "PT1H30M"), so when the when-fields are unchanged we carry the original
// `start`/`duration`/`timeZone`/`showWithoutTime` verbatim and only recompute when they changed.
// ---------------------------------------------------------------------------

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
// One source of truth so the optimistic event and the patch can't drift. recurrenceRule/participants/
// keywords/color/uid/calendarIds are absent here → never touched → carried through.
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
  };
}

const WHEN_ERROR = "Enter a valid start and end; the end can't be before the start.";

/**
 * A validation message for the EDIT form's when-fields, or null when valid. Only flags a when the
 * user actually CHANGED (an unchanged event is always valid — it loaded from the server), so opening
 * a malformed-looking event and saving without touching the time never blocks. The store action gates
 * on this too (enforcement at the boundary, not just the UI).
 */
export function editableEventError(baseline: CalendarEvent, edits: EditableEvent): string | null {
  if (whenChanged(baseline, edits) && editableWhen(edits) === null) {
    return WHEN_ERROR;
  }
  return null;
}

/**
 * A validation message for the CREATE form's when-fields, or null when valid. Unlike the edit path
 * (which carries an unchanged baseline through), a create always needs a concrete, valid when — so
 * this flags any unparseable/end-before-start when outright. Same message as the edit path.
 */
export function createEventError(edits: EditableEvent): string | null {
  return editableWhen(edits) === null ? WHEN_ERROR : null;
}

/**
 * Apply the form's working copy onto the base event, producing the full event for an OPTIMISTIC store
 * write. Properties the form doesn't expose (recurrenceRule, participants, keywords, color, uid,
 * calendarIds, …) are carried through untouched; an emptied editable property is removed.
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
 * to its rebuilt value or `null` to remove it. Unchanged properties — and every property the form
 * doesn't expose (recurrenceRule, participants, …) — are absent, so the patch never rewrites or
 * clobbers them. An all-unchanged edit yields `{}` (the store action treats that as a no-op).
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
// Create — a NEW event from a blank working copy, reusing the same rebuildEvent as the edit path so
// the two transforms can't drift. The create form exposes the SAME editable set as edit (title, when,
// location, description, status/free-busy/privacy); recurrence + participants are NOT settable here
// (the form has no field, and Stalwart drops participants on create anyway — probed live), so they're
// simply absent from the body. The server assigns `uid` and the id.
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
 * `calendarIds` plus every editable property that survives the rebuild (blanks dropped). No `id` or
 * `uid` — the server assigns both (a client-chosen uid buys nothing here and risks a collision on a
 * duplicate create). Recurrence/participants are absent (not exposed). Same {@link rebuildEvent} as
 * the edit/patch transforms, so they can't drift. Caller MUST ensure {@link editableHasContent}.
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
