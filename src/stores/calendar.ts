import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { drainChanges } from "@/jmap/changes";
import {
  CAP_CALENDARS,
  CAP_CORE,
  calendarChanges,
  calendarEventChanges,
  calendarEventGet,
  calendarEventQuery,
  calendarGet,
  idsFromCalendarEventQuery,
  methodResult,
} from "@/jmap/methods";
import type { Calendar, CalendarEvent, MethodResponse } from "@/jmap/types";
import { handleAuthFailure, jmap, session } from "./account";
import { syncCollection } from "./sync-collection";

export const [calendars, setCalendars] = createStore<Record<string, Calendar>>({});
export const [calendarEvents, setCalendarEvents] = createStore<Record<string, CalendarEvent>>({});
// The agenda's event ids in the CalendarEvent/query result order (start-ascending, recurrences
// expanded) — the event store is keyed by these (possibly synthetic) occurrence ids. Unlike contacts
// (no server sort), the calendar query CAN sort by start, so this captures a server-ordered id list.
// The agenda component still groups these by day and sorts within each day (`groupEventsByDay` →
// `compareEvents`) for the grouped display; that per-day sort is by start too, so it's consistent
// with this order (and breaks same-start ties deterministically).
export const [eventIds, setEventIds] = createSignal<string[]>([]);

const CALENDAR_USING = [CAP_CORE, CAP_CALENDARS];

// How far forward the agenda loads. The query is a date window (today → +WINDOW_DAYS); past/forward
// paging is a follow-up (the read-only v1 shows "upcoming"). Well within Stalwart's advertised
// maxExpandedQueryDuration (P52W1D) so expandRecurrences never overflows the window.
const WINDOW_DAYS = 56;

// Sync cursors (from /get and /changes), used as `sinceState` for the *_changes calls. Plain
// module state — they're sync cursors, not reactive UI state (same as mailboxState/contactState).
let calendarState = "";
let eventState = "";

// Calendar loads lazily on first open of the Calendar view (not on connect), so most mail-only
// sessions never fetch it. `calendarReady` is reactive so the UI can tell "loading" from "loaded
// but empty"; it also gates the push-driven sync — a change pushed before the view was ever opened
// is ignored (the eventual lazy load fetches fresh). `loadInFlight` dedupes concurrent opens.
export const [calendarReady, setCalendarReady] = createSignal(false);
let loadInFlight: Promise<void> | null = null;

/**
 * The account that holds calendars, or null if the session exposes none. Resolved from
 * `primaryAccounts[urn:…:calendars]` rather than assuming the mail account — they coincide on the
 * dev server, but a shared/secondary account could differ. Reactive (reads the `session` signal).
 */
export function calendarAccountId(): string | null {
  return session()?.primaryAccounts[CAP_CALENDARS] ?? null;
}

/**
 * Whether this account can do calendars: the server advertises the capability AND a primary
 * calendar account exists. Reactive — the view switch gates the Calendar tab on it, so the tab is
 * enabled only once a calendar-capable session is connected and fails safe (disabled) otherwise.
 */
export function calendarAvailable(): boolean {
  const s = session();
  return s ? CAP_CALENDARS in s.capabilities && calendarAccountId() !== null : false;
}

// The agenda's date window: local midnight today → +WINDOW_DAYS, as UTC instants (the filter
// compares against the event's resolved instant). Recomputed per load so "today" stays current.
function agendaWindow(): { after: string; before: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + WINDOW_DAYS);
  return { after: start.toISOString(), before: end.toISOString() };
}

// Apply a CalendarEvent/query → CalendarEvent/get response pair: capture the object-state cursor
// (off the /get, which is a valid `sinceState` for /changes — verified live), reconcile the event
// store to the fetched events, and set the agenda order from the QUERY ids (the start-sorted,
// recurrence-expanded order; the /get list order isn't guaranteed). reconcile gives referential
// stability so unchanged rows don't re-render.
function applyEventResponses(
  responses: MethodResponse[],
  queryCallId: string,
  getCallId: string,
): void {
  const q = methodResult(responses, queryCallId);
  const ev = methodResult(responses, getCallId);
  if (typeof ev.state === "string") eventState = ev.state;
  const map: Record<string, CalendarEvent> = {};
  for (const e of (ev.list ?? []) as CalendarEvent[]) map[e.id] = e;
  setCalendarEvents(reconcile(map));
  setEventIds((q.ids ?? []) as string[]);
}

// Fetch calendars + the agenda window in one round trip (Calendar/get, then the canonical
// CalendarEvent/query → CalendarEvent/get chain with recurrences expanded). Captures both state
// cursors. Throws on failure — loadCalendar wraps it with the load-once guard + error handling.
async function fetchCalendar(): Promise<void> {
  const accountId = calendarAccountId();
  if (!accountId) return; // capability absent — nothing to load (view switch keeps the tab disabled)
  const client = jmap();
  const { after, before } = agendaWindow();
  const responses = await client.request(
    [
      calendarGet(accountId, "cal"),
      calendarEventQuery(accountId, "q", { filter: { after, before }, expandRecurrences: true }),
      calendarEventGet(accountId, "ev", { idsRef: idsFromCalendarEventQuery("q") }),
    ],
    CALENDAR_USING,
  );

  const calResult = methodResult(responses, "cal");
  if (typeof calResult.state === "string") calendarState = calResult.state;
  const cals: Record<string, Calendar> = {};
  for (const c of (calResult.list ?? []) as Calendar[]) cals[c.id] = c;
  setCalendars(reconcile(cals));

  applyEventResponses(responses, "q", "ev");
  setCalendarReady(true);
}

/**
 * Load the calendar once. Idempotent — returns immediately if already loaded, joins an in-flight
 * load otherwise — and never rejects (an auth failure raises the re-auth gate; anything else is
 * logged), so the Calendar view's onMount can fire it freely. A failed load leaves `calendarReady`
 * false so the next open retries.
 */
export function loadCalendar(): Promise<void> {
  if (calendarReady()) return Promise.resolve();
  if (loadInFlight) return loadInFlight;
  loadInFlight = fetchCalendar()
    .catch((err) => {
      if (!handleAuthFailure(err)) console.error("Calendar load failed:", err);
    })
    .finally(() => {
      loadInFlight = null;
    });
  return loadInFlight;
}

// Re-run the agenda window query → get and reconcile. Used by syncCalendar when an event changed:
// the agenda is an EXPANDED view, so we can't upsert a base-event delta into it by id (see below) —
// re-querying the window is the correct, simple refresh.
async function refetchEvents(accountId: string): Promise<void> {
  const client = jmap();
  const { after, before } = agendaWindow();
  const responses = await client.request(
    [
      calendarEventQuery(accountId, "q", { filter: { after, before }, expandRecurrences: true }),
      calendarEventGet(accountId, "ev", { idsRef: idsFromCalendarEventQuery("q") }),
    ],
    CALENDAR_USING,
  );
  applyEventResponses(responses, "q", "ev");
}

/**
 * Apply server-pushed calendar changes incrementally. No-op until the calendar has been loaded (a
 * push before the view opened is ignored; the lazy load will fetch current state). Falls back to a
 * full reload on cannotCalculateChanges / transient failure, which also resets the cursors. Raises
 * the re-auth gate on an auth failure.
 *
 * Calendars (the containers) sync incrementally by stable id via the shared {@link syncCollection}.
 * Events do NOT: the agenda is a `CalendarEvent/query` with `expandRecurrences`, whose synthetic
 * per-occurrence ids (e.g. `eaaaaaf`) don't match the BASE event ids that `CalendarEvent/changes`
 * reports — so a changed base event can't be upserted into the expanded store by id. Instead we
 * drain the event /changes only to learn WHETHER anything changed (and to advance the cursor / catch
 * cannotCalculateChanges), then re-query the window when it did. Cursor discipline holds: apply the
 * change (re-query) before persisting the advanced cursor.
 */
export async function syncCalendar(): Promise<void> {
  if (!calendarReady()) return;
  const accountId = calendarAccountId();
  if (!accountId) return;
  const client = jmap();
  try {
    calendarState = await syncCollection<Calendar>(
      client,
      calendarState,
      (since) => calendarChanges(accountId, since, "calc"),
      (ids) => calendarGet(accountId, "calget", { ids }),
      (list) =>
        setCalendars(
          produce((s) => {
            for (const c of list) s[c.id] = c;
          }),
        ),
      (ids) =>
        setCalendars(
          produce((s) => {
            for (const id of ids) delete s[id];
          }),
        ),
      CALENDAR_USING,
    );

    const drained = await drainChanges(
      client,
      eventState,
      (since) => calendarEventChanges(accountId, since, "evc"),
      CALENDAR_USING,
    );
    if (drained.created.length > 0 || drained.updated.length > 0 || drained.destroyed.length > 0) {
      // refetchEvents recaptures eventState from the fresh /get — the latest object state, which is
      // >= the drained newState, so the next sync drains from there.
      await refetchEvents(accountId);
    } else {
      eventState = drained.newState;
    }
  } catch (err) {
    if (handleAuthFailure(err)) return;
    // cannotCalculateChanges (or a transient failure) → rebuild from scratch, which also resets the
    // cursors to a usable baseline. Clear ready so loadCalendar actually refetches.
    setCalendarReady(false);
    await loadCalendar();
  }
}

/** Test seam: drop all calendar state so a suite starts clean (wired into the harness resetStores). */
export function resetCalendar(): void {
  setCalendars(reconcile({}));
  setCalendarEvents(reconcile({}));
  setEventIds([]);
  calendarState = "";
  eventState = "";
  setCalendarReady(false);
  loadInFlight = null;
}
