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
  type SetResult,
  setResult,
} from "@/jmap/methods";
import type { Calendar, CalendarEvent, Id, MethodResponse, SetError } from "@/jmap/types";
import {
  baseEventIdCandidates,
  createdEventFor,
  createEventBody,
  type EditableEvent,
  editableEventError,
  editableHasContent,
  editableToEvent,
  editableToPatch,
  freshOccurrenceIdForBase,
  pickBaseEvent,
  recurrenceValid,
  visibleRange,
} from "@/lib/calendar";
import { handleAuthFailure, jmap, session } from "./account";
import { syncCollection } from "./sync-collection";
import {
  calendarAnchor,
  calendarViewMode,
  selectedCalendarId,
  selectedEventId,
  setSelectedEventId,
} from "./ui";

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

// The currently-visible date window as UTC instants (the filter compares against the event's resolved
// instant). Derived from the live view-mode + anchor signals (lib/calendar `visibleRange`): the agenda
// rolls forward from the anchor, the grids span the visible month/week/day. Read at request time (not
// reactively) so each load/sync/nav re-query captures the window the user is currently looking at.
function currentWindow(): { after: string; before: string } {
  return visibleRange(calendarViewMode(), calendarAnchor());
}

// A stable key for the visible window (its query range) — captured before a window query and
// re-checked at apply time. Any window result is dropped unless it still matches the CURRENT window,
// so a query for a window the user has since navigated away from can't clobber the one they're now
// looking at. ONE supersede mechanism keyed on the window itself (not call order), covering BOTH a
// nav superseding an earlier nav AND a nav superseding an in-flight sync/mutation reconcile (which
// reads the window at request time but could otherwise apply its older window after the nav).
function windowKey(): string {
  const { after, before } = currentWindow();
  return `${after}|${before}`;
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

// Request the visible window, then apply ITS result only if the user is still looking at that window
// ({@link windowKey} unchanged across the round trip). Every window re-query (nav + the sync/mutation
// reconcile) goes through here, so a stale window can never clobber the current one. `eventState` is
// still recaptured from a matching apply (it's the account-global object state, valid regardless of
// window). Captures the key BEFORE the request — requestWindow reads the same live window synchronously.
async function requestAndApplyWindow(accountId: string): Promise<void> {
  const key = windowKey();
  const responses = await requestWindow(accountId);
  if (windowKey() !== key) return; // navigated away mid-request — drop this stale window
  applyEventResponses(responses, "q", "ev");
}

// Fetch calendars + the agenda window in one round trip (Calendar/get, then the canonical
// CalendarEvent/query → CalendarEvent/get chain with recurrences expanded). Captures both state
// cursors. Throws on failure — loadCalendar wraps it with the load-once guard + error handling.
async function fetchCalendar(): Promise<void> {
  const accountId = calendarAccountId();
  if (!accountId) return; // capability absent — nothing to load (view switch keeps the tab disabled)
  const client = jmap();
  const { after, before } = currentWindow();
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

// Issue the visible-window CalendarEvent/query → CalendarEvent/get and return the raw responses (no
// apply). Shared by refetchEvents (the mutation/sync reconcile) and refetchWindow (view navigation),
// so the canonical expanded query is defined in one place.
async function requestWindow(accountId: string): Promise<MethodResponse[]> {
  const client = jmap();
  const { after, before } = currentWindow();
  return client.request(
    [
      calendarEventQuery(accountId, "q", { filter: { after, before }, expandRecurrences: true }),
      calendarEventGet(accountId, "ev", { idsRef: idsFromCalendarEventQuery("q") }),
    ],
    CALENDAR_USING,
  );
}

// Re-run the visible-window query → get and reconcile. Used by syncCalendar / the mutation paths when
// an event changed: the agenda + grids are an EXPANDED view, so we can't upsert a base-event delta into
// them by id (see below) — re-querying the window is the correct, simple refresh. Window-key-guarded
// (see requestAndApplyWindow) so a reconcile in flight when the user navigates can't apply its old
// window over the new one.
async function refetchEvents(accountId: string): Promise<void> {
  await requestAndApplyWindow(accountId);
}

/**
 * Re-query the visible window after a view-mode/anchor change (navigation). Awaits any in-flight first
 * load so a nav done before the initial fetch completes still wins (it re-queries the now-current
 * window on top of the load), then applies the new window — unless the user navigated again mid-request
 * (the {@link windowKey} guard in requestAndApplyWindow drops the stale result). No-op until the
 * calendar has loaded (the lazy first load owns the initial window) or when the capability is absent.
 * Never rejects; an auth failure raises the global re-auth gate, anything else is logged (the previous
 * window stays on screen). The Calendar surface calls this from an effect watching the mode + anchor.
 */
export async function refetchWindow(): Promise<void> {
  if (loadInFlight) {
    try {
      await loadInFlight;
    } catch {
      // The first load's own error handling already ran; if it failed, calendarReady stays false and
      // the guard below returns (the next view open retries the load).
    }
  }
  if (!calendarReady()) return;
  const accountId = calendarAccountId();
  if (!accountId) return;
  try {
    await refetchEvents(accountId);
  } catch (err) {
    if (handleAuthFailure(err)) return;
    console.error("Calendar window re-query failed:", err);
  }
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
  // Accumulate into a Set: it dedupes (a server with overlapping pages can't bloat the candidate match
  // / the follow-up get) AND lets us detect "no forward progress" — a non-empty page that adds zero new
  // ids means the server is ignoring `position`, so stop rather than loop to the cap.
  const seen = new Set<string>();
  let position = 0;
  // Unknown until the server reports it. Fall back to Infinity (NOT seen.size) so a server that omits
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
    const before = seen.size;
    for (const id of pageIds) seen.add(id);
    if (needTotal && typeof result.total === "number") total = result.total;
    position += pageIds.length;
    // Stop on: an empty page (a correctly-paging server's natural end), a non-empty page that added no
    // new ids (no forward progress — the server is ignoring `position`), or once we've collected `total`.
    if (pageIds.length === 0 || seen.size === before || seen.size >= total) break;
  }
  return [...seen];
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
 * pointers (which may include `recurrenceRule` when the repeat changed — editing a recurring event
 * here changes the WHOLE series), leaving unedited properties (`participants`/etc.) untouched. Resolves
 * with a {@link SaveEventResult} (never rejects) so the form can surface a failure inline.
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
  // are left to the reconcile re-query; calendarIds is untouched. A recurrence-rule change isn't
  // overlaid either — it re-expands the series, which only the full re-query can rebuild.
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

/** The outcome of a {@link createEvent}: the new server id on success, else why it didn't persist. */
export type CreateEventResult =
  | { ok: true; id: Id }
  | {
      ok: false;
      reason: "empty" | "invalid" | "no-account" | "auth" | "refused" | "error";
      error?: SetError;
    };

/**
 * Create a new event from the form's working copy in the chosen calendar(s). Issued as ONE
 * `CalendarEvent/set create`; the server assigns the id + uid and re-keys our creation id (`new` →
 * server BASE id), exactly like the contacts/email create paths. Resolves with a
 * {@link CreateEventResult} (never rejects) so the form can surface a failure inline.
 *
 * Discipline mirrors saveEvent / createContact ([[jmap-set-quirks]] / [[qelo-review-checklist]]):
 * `requireNewState:false` (an all-failed /set omits newState on Stalwart; this path syncs via
 * CalendarEvent/changes, not this token). A contentless working copy (no title or an invalid when) is
 * rejected without a round trip — the create-form analog of saveEvent's empty-patch no-op (the form
 * gates Save on the same {@link editableHasContent}). Nothing is written until the server confirms, so
 * a refusal/transport error needs no rollback.
 *
 * The agenda is the EXPANDED (synthetic-keyed) view, and the create returns the BASE id (Stalwart's
 * created map carries only `id`). So after the create: optimistically seed the new base event for an
 * instant render, then reconcile via a full window re-query ({@link refetchEvents}) — where the new
 * event re-appears under its SYNTHETIC occurrence id IF it falls in the currently VISIBLE window. The
 * selection is then re-pointed from the base id to that occurrence by a fail-safe suffix match (the
 * inverse of resolveBaseEvent): a single freshly-appeared occurrence ending in the base id is selected,
 * otherwise the selection is cleared rather than left dangling on a base id absent from the store. The
 * create form seeds its default date INTO the visible window (lib `createSeedDate`), so a normal create
 * lands in view even when the calendar is navigated away from today; an event placed outside the window
 * (an explicit far date) isn't in the view — the form closes and the detail shows the empty state;
 * acceptable (same posture as saveEvent moving an event out of the visible window).
 */
export async function createEvent(
  edits: EditableEvent,
  calendarIds: Record<string, true>,
): Promise<CreateEventResult> {
  if (!editableHasContent(edits)) return { ok: false, reason: "empty" };
  // Enforce recurrence validity at the store boundary too (not just the form): a programmatic caller
  // with an invalid repeat (interval/count < 1, bad until) must be refused before any CalendarEvent/set.
  if (!recurrenceValid(edits.recurrence)) return { ok: false, reason: "invalid" };
  const accountId = calendarAccountId();
  if (!accountId) return { ok: false, reason: "no-account" };

  const body = createEventBody(edits, calendarIds);
  const client = jmap();
  let result: SetResult<CalendarEvent>;
  try {
    const responses = await client.request(
      [calendarEventSet(accountId, "set", { create: { new: body } })],
      CALENDAR_USING,
    );
    result = setResult<CalendarEvent>(responses, "set", { requireNewState: false });
  } catch (err) {
    if (handleAuthFailure(err)) return { ok: false, reason: "auth" };
    console.error("CalendarEvent/set create failed:", err);
    return { ok: false, reason: "error" };
  }

  const refused = result.notCreated.new;
  if (refused) return { ok: false, reason: "refused", error: refused };
  const id = result.created.new?.id;
  if (!id) {
    // Created without a refusal but the server returned no id — it can't be addressed. Treat as an
    // error rather than guessing; the next Calendar-view open / sync re-queries and surfaces it.
    console.error("CalendarEvent/set create returned no id");
    return { ok: false, reason: "error" };
  }

  // Snapshot the existing occurrence ids BEFORE the optimistic seed so we can tell the new occurrence
  // apart after the reconcile (a pre-existing occurrence could coincidentally end in the new base id;
  // `!before.has` excludes it). Seed the new base event so it renders at once, prepend it to the
  // agenda order, and select it.
  const before = new Set(eventIds());
  setCalendarEvents(
    produce((s) => {
      s[id] = createdEventFor(id, edits, calendarIds);
    }),
  );
  setEventIds((ids) => [id, ...ids]);
  setSelectedEventId(id);

  // Reconcile to server truth (best-effort): replaces the base-id seed with the synthetic-keyed
  // occurrence, then re-point the selection to it. A reconcile blip leaves the seed selected (it
  // persisted server-side) until the next sync re-queries.
  try {
    await refetchEvents(accountId);
    // Re-point the selection from the base id to the new synthetic occurrence; fail safe (clear) when
    // it's out of window (none) or ambiguous (several) rather than strand a dangling base-id selection.
    setSelectedEventId(freshOccurrenceIdForBase(id, eventIds(), before));
  } catch (err) {
    handleAuthFailure(err);
  }
  return { ok: true, id };
}

/** The outcome of a {@link deleteEvent}: ok on success, else why it didn't delete. */
export type DeleteEventResult =
  | { ok: true }
  | {
      ok: false;
      reason: "no-account" | "unresolved" | "auth" | "refused" | "error";
      error?: SetError;
    };

/**
 * Delete an event. The agenda is keyed by SYNTHETIC expanded-occurrence ids, but `CalendarEvent/set
 * destroy` — like `set update` — REJECTS a synthetic id (`invalidProperties: "Deleting synthetic ids
 * is not yet supported."`, probed live 2026-06-17) and needs the BASE event id. So `occurrenceId` is
 * first resolved to its base via the same {@link resolveBaseEvent} the edit path uses (paged
 * non-expanded query → suffix candidates → content disambiguation, fail-safe to null), then ONE
 * `CalendarEvent/set destroy` targets that base. A null resolution returns `unresolved` rather than
 * risk destroying the wrong series, so the caller keeps the read-only detail.
 *
 * RECURRING-EVENT CAVEAT: destroying the base id removes the WHOLE series (probed live — every
 * occurrence vanishes), not just the viewed occurrence; per-occurrence delete (a `recurrenceOverrides`
 * `excluded` exception) is not yet wired here (a later branch of the recurrence-editing milestone), so
 * a delete still acts on the whole series. The confirm copy says as much.
 *
 * The clicked occurrence is pruned from `calendarEvents` + `eventIds` (and the selection cleared if it
 * pointed at it) optimistically for instant feedback; on success a full-window reconcile re-query
 * ({@link refetchEvents}) drops the rest of a recurring series (the expanded, synthetic-keyed store
 * can't be upserted by base id — the same reason saveEvent/syncCalendar re-query). Discipline mirrors
 * the contacts `deleteContact` / email `deleteForever` ([[jmap-set-quirks]] / [[qelo-review-checklist]]):
 * `requireNewState:false` (a fully-refused destroy omits newState on Stalwart; this path syncs via
 * `CalendarEvent/changes`, not this token, and the reconcile re-query recaptures `eventState` from a
 * full /get exactly like load/sync); a `notFound` refusal counts as gone (kept pruned); only a
 * substantive refusal or a transport error restores the occurrence, guarded against a concurrent sync
 * having re-added it / moved the selection. Resolves (never rejects) so the caller can surface a
 * failure inline.
 */
export async function deleteEvent(occurrenceId: string): Promise<DeleteEventResult> {
  const accountId = calendarAccountId();
  if (!accountId) return { ok: false, reason: "no-account" };

  // Resolve the BASE id BEFORE any optimistic change — a resolve failure then needs no restore. An
  // auth failure during the resolve raises the global gate; a null result means the base can't be
  // safely identified (gone/ambiguous), so we refuse rather than destroy a guessed-wrong series.
  let base: CalendarEvent | null;
  try {
    base = await resolveBaseEvent(occurrenceId);
  } catch (err) {
    if (handleAuthFailure(err)) return { ok: false, reason: "auth" };
    console.error("resolveBaseEvent (delete) failed:", err);
    return { ok: false, reason: "error" };
  }
  if (!base) return { ok: false, reason: "unresolved" };
  const baseId = base.id;

  // Optimistic prune of the clicked occurrence: snapshot it (to a plain object — not a live store
  // proxy, which the delete empties) for a guarded restore, and remember whether it was selected so a
  // restore re-selects only what the prune cleared. The agenda position isn't captured: the eventIds
  // order isn't load-bearing (EventList re-derives the order via groupEventsByDay), so a restore
  // re-appends rather than threading a stale index through the async destroy.
  const occurrence = calendarEvents[occurrenceId];
  const removed = occurrence ? (structuredClone(unwrap(occurrence)) as CalendarEvent) : null;
  const wasSelected = selectedEventId() === occurrenceId;
  setCalendarEvents(
    produce((s) => {
      delete s[occurrenceId];
    }),
  );
  setEventIds((ids) => ids.filter((id) => id !== occurrenceId));
  if (wasSelected) setSelectedEventId(null);

  const client = jmap();
  let refused: SetError | undefined;
  try {
    const responses = await client.request(
      [calendarEventSet(accountId, "set", { destroy: [baseId] })],
      CALENDAR_USING,
    );
    const r = setResult<CalendarEvent>(responses, "set", { requireNewState: false });
    // notFound = already gone (destroyed elsewhere) → keep it pruned; only a substantive refusal
    // leaves the event on the server and warrants a restore.
    const err = r.notDestroyed[baseId];
    if (err && err.type !== "notFound") refused = err;
  } catch (err) {
    // The destroy never applied — restore the occurrence + selection, independent of the re-auth gate
    // (the deletion didn't persist either way), then raise that gate / report the error.
    restoreOccurrence(removed, wasSelected);
    if (handleAuthFailure(err)) return { ok: false, reason: "auth" };
    console.error("CalendarEvent/set destroy failed:", err);
    return { ok: false, reason: "error" };
  }

  if (refused) {
    restoreOccurrence(removed, wasSelected);
    return { ok: false, reason: "refused", error: refused };
  }

  // Success: drop the rest of a recurring series (and confirm the prune) by reconciling the agenda to
  // server truth. Best-effort — a re-query blip leaves any lingering occurrences until the next sync.
  try {
    await refetchEvents(accountId);
  } catch (err) {
    handleAuthFailure(err);
  }
  return { ok: true };
}

// Reverse an optimistic occurrence prune the server refused (or a transport error left unconfirmed).
// Guarded like deleteContact/deleteForever: re-insert into the event store AND the agenda list, each
// only if a concurrent sync (a refetch rebuilds both together) hasn't already re-added the occurrence
// with possibly-newer data — the two presence checks are independent so neither can strand the other.
// Re-append to eventIds (order isn't load-bearing; EventList re-sorts). Re-select only if nothing else
// was selected across the await, so a refusal doesn't yank the user off an event they opened meanwhile.
function restoreOccurrence(removed: CalendarEvent | null, reselect: boolean): void {
  if (!removed) return;
  if (!calendarEvents[removed.id]) {
    setCalendarEvents(
      produce((s) => {
        s[removed.id] = removed;
      }),
    );
  }
  if (!eventIds().includes(removed.id)) {
    setEventIds((ids) => [...ids, removed.id]);
  }
  if (reselect && selectedEventId() === null) setSelectedEventId(removed.id);
}

/**
 * The loaded window's events in query order, filtered to the selected calendar (null = all calendars)
 * and skipping any id not yet in the store — the shared event source for BOTH the agenda (EventList)
 * and the month grid (MonthGrid), so the filter rule lives in one place. Reactive: reads `eventIds`,
 * `calendarEvents`, and `selectedCalendarId`; callers wrap it in a memo.
 */
export function selectedCalendarEvents(): CalendarEvent[] {
  const calId = selectedCalendarId();
  const list: CalendarEvent[] = [];
  for (const id of eventIds()) {
    const event = calendarEvents[id];
    if (!event) continue;
    if (calId !== null && event.calendarIds?.[calId] !== true) continue;
    list.push(event);
  }
  return list;
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
