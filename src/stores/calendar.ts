import { createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { drainChanges } from "@/jmap/changes";
import {
  CAP_CALENDARS,
  CAP_CORE,
  calendarChanges,
  calendarEventChanges,
  calendarEventGet,
  calendarEventQuery,
  calendarEventSet,
  calendarGet,
  idsFromCalendarEventQuery,
  methodResult,
  setResult,
} from "@/jmap/methods";
import type { Calendar, CalendarEvent, MethodResponse, SetError } from "@/jmap/types";
import {
  baseEventIdCandidates,
  type EditableEvent,
  editableEventError,
  editableToEvent,
  editableToPatch,
  pickBaseEvent,
} from "@/lib/calendar";
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

/**
 * Resolve a (possibly synthetic, expanded-occurrence) event id to its editable BASE event. The agenda
 * stores only synthetic per-occurrence ids, but a `CalendarEvent/set update` needs the base id (and
 * the synthetic id carries no `uid`/base pointer on Stalwart) — so this fetches the real base ids via
 * a NON-expanded `CalendarEvent/query`, takes every base id that is a suffix of the synthetic id
 * ({@link baseEventIdCandidates}), fetches those candidate events, and {@link pickBaseEvent} chooses
 * the one backing the viewed occurrence (disambiguating the rare `X`-vs-`aX` suffix collision by the
 * occurrence's content). Returns null when the account is gone, no base id matches, or none can be
 * fetched — the caller then keeps the read-only detail rather than opening an edit form on a guess.
 * Throws only via the underlying transport; the caller wraps it.
 *
 * A base-id sweep ({@link fetchAllBaseEventIds} — one query per page, usually a single page) plus a
 * candidate get (almost always a single id) fire on the user's Edit click, so the latency is a
 * one-time cost per edit, not on the agenda load. The base-id query is unfiltered (no date window) so a
 * long-running series whose first occurrence predates the agenda window still resolves — its base event
 * isn't in the windowed agenda query but IS in the full base-id list.
 */
export async function resolveBaseEvent(syntheticId: string): Promise<CalendarEvent | null> {
  const accountId = calendarAccountId();
  if (!accountId) return null;
  const baseIds = await fetchAllBaseEventIds(accountId);
  const candidates = baseEventIdCandidates(syntheticId, baseIds);
  if (candidates.length === 0) return null;
  const client = jmap();
  // Fetch the candidate base events AND the occurrence itself in one get, so pickBaseEvent can
  // disambiguate a suffix collision on the occurrence's SERVER-truth content rather than depending on
  // it still being in the (push-synced, evictable) store. The synthetic occurrence id resolves to the
  // occurrence; the base ids resolve to base events. `candidates` may already contain the synthetic id
  // (a non-synthetic id that is its own base), so partition the response by id membership, not equality.
  const getResponses = await client.request(
    [calendarEventGet(accountId, "bg", { ids: [...new Set([...candidates, syntheticId])] })],
    CALENDAR_USING,
  );
  const list = (methodResult(getResponses, "bg").list ?? []) as CalendarEvent[];
  const fetched = list.find((e) => e.id === syntheticId);
  // If the id IS itself a base id (a non-expanded id that ends with other base ids — e.g. base `bc`
  // also ends with base `c`), it's the exact target: return it directly rather than running collision
  // disambiguation, which could otherwise fail safe on a title tie even though the exact base is known.
  if (fetched && candidates.includes(syntheticId)) return fetched;
  const occurrence = fetched ?? calendarEvents[syntheticId];
  const candidateEvents = list.filter((e) => candidates.includes(e.id));
  return pickBaseEvent(occurrence, candidateEvents);
}

// The page size for the base-id sweep. CalendarEvent/query is paginated and a server may cap the page,
// so we advance by the ACTUAL number returned (not PAGE) to tolerate a smaller-than-requested page.
const BASE_ID_PAGE = 256;

// Fetch EVERY base event id (non-expanded) by paging the query to completion. resolveBaseEvent suffix-
// matches against this set, so a truncated list would make a real event fail to resolve (a blocked
// edit). Stop conditions: `calculateTotal` (the normal completion — stop once we've collected `total`),
// and an empty page (a correctly-paging server's natural end when `total` is absent). The hard
// page-count cap is the backstop for a MISBEHAVING server that ignores `position` and keeps returning a
// non-empty page forever — that won't loop unbounded, though it will collect duplicates up to the cap.
async function fetchAllBaseEventIds(accountId: string): Promise<string[]> {
  const client = jmap();
  const ids: string[] = [];
  let position = 0;
  // Unknown until the server reports it. Fall back to Infinity (NOT ids.length) so a server that omits
  // `total` pages until an empty page instead of stopping after one (which would reintroduce truncation).
  let total = Number.POSITIVE_INFINITY;
  for (let page = 0; page < 1000; page += 1) {
    // Only ask the server to compute `total` until we have it — recomputing it on every page is
    // needless work that adds latency on a large account (this whole sweep runs on the Edit click).
    const needTotal = total === Number.POSITIVE_INFINITY;
    const responses = await client.request(
      [
        calendarEventQuery(accountId, "bq", {
          // Explicitly non-expanded: this MUST return base ids (the ones CalendarEvent/set accepts),
          // not the synthetic per-occurrence ids the agenda's expandRecurrences query yields.
          expandRecurrences: false,
          position,
          limit: BASE_ID_PAGE,
          ...(needTotal ? { calculateTotal: true } : {}),
        }),
      ],
      CALENDAR_USING,
    );
    const result = methodResult(responses, "bq");
    const pageIds = (result.ids ?? []) as string[];
    ids.push(...pageIds);
    if (needTotal && typeof result.total === "number") total = result.total;
    position += pageIds.length;
    if (pageIds.length === 0 || ids.length >= total) break;
  }
  // Dedupe at the boundary: a misbehaving server (or overlapping pages) can repeat ids, which would
  // otherwise bloat the candidate match + the follow-up CalendarEvent/get ids list. Unique ids keep
  // the resolver work bounded without changing correctness for a well-behaved server.
  return [...new Set(ids)];
}

/** The outcome of a {@link saveEvent}: ok on success/no-op, else why it didn't persist. */
export type SaveEventResult =
  | { ok: true }
  | {
      ok: false;
      reason: "no-account" | "invalid" | "auth" | "refused" | "error";
      error?: SetError;
    };

/**
 * Save edits to an existing event. `baseId` is the BASE event id ({@link resolveBaseEvent}); `baseline`
 * is the base event the form was seeded from (its open-time snapshot); `occurrenceId` is the synthetic
 * agenda id the user was viewing (the optimistic write target — the store is keyed by occurrence ids).
 * The patch is the diff between the baseline and the edits, so it carries only the properties the user
 * changed — issued as ONE `CalendarEvent/set update` (a JSON-pointer patch) that touches only those
 * pointers, leaving `recurrenceRule`/`participants`/etc. untouched. Resolves with a
 * {@link SaveEventResult} (never rejects) so the form can surface a failure inline.
 *
 * The agenda is an EXPANDED view (synthetic-keyed, un-upsertable by base id — see syncCalendar), so:
 *  - the optimistic write overlays the changed NON-temporal properties onto the viewed occurrence for
 *    instant feedback (temporal props differ per occurrence, so they're left to the reconcile);
 *  - the reconcile is a full window re-query ({@link refetchEvents}) — the only way to rebuild the
 *    expanded view, and how it picks up a moved/re-expanded series. This recaptures `eventState` from
 *    a full /get (consistent with load/sync — not a partial reconcile that must avoid the cursor).
 * Discipline mirrors saveContact ([[jmap-set-quirks]] / [[qelo-review-checklist]]): `requireNewState:
 * false` (an all-failed /set omits newState on Stalwart; this path syncs via CalendarEvent/changes,
 * not this token); on a refusal OR transport error the optimistic overlay is reverted to server truth
 * (re-query), INDEPENDENT of the auth gate (the change didn't persist either way). An empty patch
 * (nothing changed) is a no-op success; an invalid when is rejected without a round trip.
 */
export async function saveEvent(
  occurrenceId: string,
  baseId: string,
  baseline: CalendarEvent,
  edits: EditableEvent,
): Promise<SaveEventResult> {
  const accountId = calendarAccountId();
  if (!accountId) return { ok: false, reason: "no-account" };
  if (editableEventError(baseline, edits)) return { ok: false, reason: "invalid" };

  const patch = editableToPatch(baseline, edits);
  if (Object.keys(patch).length === 0) return { ok: true }; // nothing changed

  // Optimistic overlay of the changed NON-temporal props onto the viewed occurrence (snapshot it for
  // a revert). Temporal props (start/duration/timeZone/showWithoutTime) belong to each occurrence and
  // are left to the reconcile re-query; calendarIds/recurrence are untouched.
  const occurrence = calendarEvents[occurrenceId];
  const restore = occurrence ? (structuredClone(unwrap(occurrence)) as CalendarEvent) : null;
  if (occurrence) {
    const rebuilt = editableToEvent(baseline, edits);
    setCalendarEvents(
      produce((s) => {
        const target = s[occurrenceId];
        if (!target) return;
        const view = target as unknown as Record<string, unknown>;
        for (const key of [
          "title",
          "description",
          "locations",
          "status",
          "freeBusyStatus",
          "privacy",
        ] as const) {
          if (rebuilt[key] === undefined) delete view[key];
          else view[key] = rebuilt[key];
        }
      }),
    );
  }

  const client = jmap();
  let refused: SetError | undefined;
  try {
    const responses = await client.request(
      [calendarEventSet(accountId, "set", { update: { [baseId]: patch } })],
      CALENDAR_USING,
    );
    refused = setResult<CalendarEvent>(responses, "set", { requireNewState: false }).notUpdated[
      baseId
    ];
  } catch (err) {
    // The /set never applied — revert the optimistic overlay (to server truth via re-query, or the
    // snapshot if that also fails), independent of the re-auth gate, then raise that gate / report.
    await revertEventOverlay(accountId, occurrenceId, restore);
    if (handleAuthFailure(err)) return { ok: false, reason: "auth" };
    console.error("CalendarEvent/set update failed:", err);
    return { ok: false, reason: "error" };
  }

  // The /set applied (fully, or with a per-item refusal). Reconcile the agenda to server truth: on
  // success this absorbs the change + any re-expansion; on a refusal it undoes the optimistic overlay.
  try {
    await refetchEvents(accountId);
  } catch (err) {
    handleAuthFailure(err);
    // A re-query blip. On a refusal the server rejected the write, so fall back to the occurrence
    // snapshot regardless (else rejected data lingers); on success the overlay ≈ truth, so keep it.
    if (refused && restore) {
      setCalendarEvents(
        produce((s) => {
          s[occurrenceId] = restore;
        }),
      );
    }
  }
  return refused ? { ok: false, reason: "refused", error: refused } : { ok: true };
}

// Revert an optimistic overlay after the /set itself failed: re-query server truth, or restore the
// occurrence snapshot if even the re-query fails (so the agenda isn't stuck on a guess).
async function revertEventOverlay(
  accountId: string,
  occurrenceId: string,
  restore: CalendarEvent | null,
): Promise<void> {
  try {
    await refetchEvents(accountId);
  } catch {
    if (restore) {
      setCalendarEvents(
        produce((s) => {
          s[occurrenceId] = restore;
        }),
      );
    }
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
