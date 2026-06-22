import { createStore, produce } from "solid-js/store";
import { drainChanges } from "@/jmap/changes";
import {
  DETAIL_PROPERTIES,
  type EmailPatch,
  type EmailQueryOptions,
  emailChanges,
  emailGet,
  emailQuery,
  emailQueryChanges,
  emailSet,
  idsFromQuery,
  JmapMethodError,
  LIST_PROPERTIES,
  methodResult,
  setResult,
  threadGet,
} from "@/jmap/methods";
import type { Email } from "@/jmap/types";
import { handleAuthFailure, jmap } from "./account";
import { mailboxes, mailboxIdByRole, selectedMailboxRights } from "./mailboxes";
import { notify } from "./toasts";
import { selectedThreadId, setSelectedEmailId, setSelectedThreadId } from "./ui";

/** Cache of fetched Email objects, keyed by id. Shared by the list and (later) reading pane. */
export const [emails, setEmails] = createStore<Record<string, Email>>({});

export interface ThreadListState {
  /** Mailbox the list currently reflects; null before any folder is opened. */
  mailboxId: string | null;
  /** Ordered representative email ids (one per collapsed conversation). */
  ids: string[];
  /** Email/query state token, for incremental sync in Phase 6. */
  queryState: string;
  loading: boolean;
  /** True once a page returns fewer than a full window — no more pages to fetch. */
  reachedEnd: boolean;
  /** Initial-load failure (the list is empty); shown in place of the list. */
  error: string | null;
  /** Pagination failure (rows are still shown); surfaced as a footer with retry. */
  loadMoreError: string | null;
}

export const [threadList, setThreadList] = createStore<ThreadListState>({
  mailboxId: null,
  ids: [],
  queryState: "",
  loading: false,
  reachedEnd: false,
  error: null,
  loadMoreError: null,
});

// Window size for a page of collapsed conversations. A `let` (not `const`) only so the
// integration suite can shrink it via `setPageSize()` to exercise multi-page paging and the
// anchor/recovery paths against the small seeded dataset without seeding 50+ conversations.
// App code never changes it.
let pageSize = 50;

/** Test seam — see `pageSize`. Reset to the default (50) between tests. */
export function setPageSize(n: number): void {
  // Guard the seam: a non-positive or fractional window produces an invalid Email/query
  // `limit` and breaks the short-page termination check, so fail loudly instead.
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`pageSize must be a positive integer, got ${n}`);
  }
  pageSize = n;
}

// Email state token (from /get and /changes responses), used as the `sinceState` for
// Email/changes. Plain module state — it's a sync cursor, not reactive UI state.
let emailState = "";

// Merge rather than replace so a list-properties refetch (e.g. a $seen flag change via
// sync) doesn't drop a body that an earlier DETAIL fetch loaded into the same record.
function cacheEmails(list: Email[]): void {
  setEmails(
    produce((store) => {
      for (const email of list) store[email.id] = { ...store[email.id], ...email };
    }),
  );
}

function rememberEmailState(getResult: Record<string, unknown>): void {
  if (typeof getResult.state === "string") emailState = getResult.state;
}

/**
 * How to position the window: from an absolute `position` (used for the first page,
 * where there's nothing to anchor to) or relative to an `anchor` id we already hold.
 * Anchoring is what keeps pagination stable under concurrent change — see fetchPage.
 */
type PageWindow = { position: number } | { anchor: string };

/**
 * One round trip: query the collapsed conversations for a window, then fetch the list
 * properties of exactly those ids via a #ids back-reference.
 *
 * For subsequent pages we anchor on the last id we already hold (`anchorOffset: 1`, i.e.
 * "the row after the anchor") rather than re-deriving an absolute `position`. Absolute
 * positions are unstable: if the result set shifts between page fetches (new mail, a
 * message read/deleted server-side), the next position lands on the wrong row — skipping
 * or repeating conversations across the page boundary. The anchor pins the boundary to a
 * concrete id, so the next page always continues exactly where the last one ended,
 * regardless of insertions or removals above it.
 */
async function fetchPage(mailboxId: string, pageWindow: PageWindow) {
  const client = jmap();
  const queryOpts: EmailQueryOptions = { mailboxId, collapseThreads: true, limit: pageSize };
  if ("anchor" in pageWindow) {
    queryOpts.anchor = pageWindow.anchor;
    queryOpts.anchorOffset = 1;
  } else {
    queryOpts.position = pageWindow.position;
  }
  const responses = await client.request([
    emailQuery(client.accountId, "q", queryOpts),
    emailGet(client.accountId, "g", { idsRef: idsFromQuery("q"), properties: LIST_PROPERTIES }),
  ]);
  const query = methodResult(responses, "q");
  const get = methodResult(responses, "g");
  cacheEmails((get.list ?? []) as Email[]);
  rememberEmailState(get);
  const ids = (query.ids ?? []) as string[];
  return {
    ids,
    queryState: (query.queryState ?? "") as string,
    // Terminate on a short page rather than on `total`: Stalwart reports `total` as the
    // raw email count, not the collapsed-thread count, so it never equals ids.length.
    reachedEnd: ids.length < pageSize,
  };
}

/** Open a mailbox: load the first page of collapsed conversations, replacing the list. */
export async function openMailbox(mailboxId: string): Promise<void> {
  // Switching folders drops any reading-pane selection from the previous one.
  setSelectedEmailId(null);
  setSelectedThreadId(null);
  setThreadList({
    mailboxId,
    ids: [],
    queryState: "",
    loading: true,
    reachedEnd: false,
    error: null,
    loadMoreError: null,
  });
  try {
    const page = await fetchPage(mailboxId, { position: 0 });
    // A newer selection may have superseded this load mid-flight; if so, discard it.
    if (threadList.mailboxId !== mailboxId) return;
    setThreadList({
      ids: page.ids,
      queryState: page.queryState,
      reachedEnd: page.reachedEnd,
      loading: false,
    });
  } catch (err) {
    if (handleAuthFailure(err)) return;
    if (threadList.mailboxId !== mailboxId) return;
    setThreadList({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Reload the current mailbox's first page in place, keeping the reading-pane selection
 * and the currently shown rows (no loading blank). Used as the sync fallback when an
 * incremental update can't be applied — unlike openMailbox, it must not clear selection.
 */
async function reloadThreadList(mailboxId: string): Promise<void> {
  try {
    const page = await fetchPage(mailboxId, { position: 0 });
    if (threadList.mailboxId !== mailboxId) return;
    setThreadList({ ids: page.ids, queryState: page.queryState, reachedEnd: page.reachedEnd });
  } catch {
    // Keep the existing rows; a later push or folder switch will retry.
  }
}

/**
 * Fetch and append one page anchored on the last id we currently hold. On `anchorNotFound`
 * (the anchor left the live result) it returns `{ deadAnchor }` naming the id the server
 * rejected, so the caller can drop exactly that row and re-anchor; otherwise returns `null`
 * (appended, reached end, recovered via a first-page fetch, or superseded). Does not touch
 * `loading`/`loadMoreError` — loadMore owns that lifecycle.
 */
async function appendPage(mailboxId: string): Promise<{ deadAnchor: string } | null> {
  const anchor = threadList.ids[threadList.ids.length - 1];
  let page: Awaited<ReturnType<typeof fetchPage>>;
  try {
    // No row to anchor on means the window was pruned empty by sync (e.g. a mass server-side
    // delete) while reachedEnd may still be false. Fetch the first page so reachedEnd and
    // queryState refresh and paging can resume — otherwise loadMore could never re-anchor and
    // would be a permanent no-op until the mailbox is reopened.
    page = await fetchPage(mailboxId, anchor === undefined ? { position: 0 } : { anchor });
  } catch (err) {
    // The anchor row was removed from the query result (deleted/moved server-side) before
    // sync pruned it from our window. Name the rejected id so the caller drops the right row.
    // (A position-0 fetch can't anchorNotFound, so `anchor` is defined whenever we get here.)
    if (err instanceof JmapMethodError && err.type === "anchorNotFound") {
      return anchor === undefined ? null : { deadAnchor: anchor };
    }
    throw err;
  }
  if (threadList.mailboxId !== mailboxId) return null;
  // Superseded if a concurrent syncThreadList changed the tail we anchored on (same mailbox)
  // while the request was in flight: the page no longer starts strictly after our last id, so
  // appending it would violate the windowing invariant (a no-op-via-dedup, gap, or disorder).
  // Drop it and let the next scroll re-anchor on the new tail. Covers the position-0 fallback
  // too: there `anchor` is undefined, so this also requires the list to still be empty.
  if (threadList.ids[threadList.ids.length - 1] !== anchor) return null;
  setThreadList(
    produce((s) => {
      // Anchoring at offset 1 makes the boundary exact: the page starts strictly after the
      // last id we hold, so position-overlap (the old failure mode) can't happen. With a
      // single receivedAt-desc collapseThreads sort a same-id duplicate effectively can't
      // arise either — anything that moves a held representative below the anchor also
      // changes that thread's representative id. This dedup is just cheap insurance: a
      // duplicate id would crash the id-keyed <For>, so we'd rather drop than risk it.
      const have = new Set(s.ids);
      for (const id of page.ids) {
        if (have.has(id)) continue;
        have.add(id); // also guard against a duplicate within page.ids itself
        s.ids.push(id);
      }
      // Track the latest page's query state so incremental sync (Email/queryChanges)
      // computes deltas from the current query, not the stale initial-load token.
      s.queryState = page.queryState;
      s.reachedEnd = page.reachedEnd;
    }),
  );
  return null;
}

// How many vanished anchors loadMore will drop+re-anchor through in one call before
// giving up. Bounds the work when a folder is mutating faster than we can page (each miss
// costs a round trip); the user can simply scroll again to resume.
const MAX_ANCHOR_RETRIES = 3;

/** Append the next page for the current mailbox (infinite scroll). */
export async function loadMore(): Promise<void> {
  const mailboxId = threadList.mailboxId;
  if (!mailboxId || threadList.loading || threadList.error || threadList.reachedEnd) return;
  setThreadList({ loading: true, loadMoreError: null });
  try {
    // appendPage reports a deadAnchor when our last row has left the result server-side before
    // sync pruned it. anchorNotFound proves that exact id is gone from the query (RFC 8620
    // §5.5), so drop it and re-anchor on the previous row — a race-free, in-place reconcile
    // that doesn't touch the queryChanges cursor (which the push-driven syncMail serializer
    // owns). Only drop when the tail is still that id: a concurrent syncThreadList may have
    // replaced/reordered the tail while our request was in flight, and the new tail is a valid
    // anchor we must not delete — stop and let the next scroll retry it. Bounded to
    // MAX_ANCHOR_RETRIES drops per call so a fast-churning folder can't spin.
    for (let dropped = 0; ; dropped += 1) {
      const miss = await appendPage(mailboxId);
      if (!miss) break; // appended, reached end, recovered, or superseded
      if (threadList.mailboxId !== mailboxId) break;
      if (threadList.ids[threadList.ids.length - 1] !== miss.deadAnchor) break;
      setThreadList("ids", (ids) => ids.slice(0, -1));
      if (dropped + 1 >= MAX_ANCHOR_RETRIES) break;
    }
    if (threadList.mailboxId === mailboxId) setThreadList({ loading: false });
  } catch (err) {
    if (handleAuthFailure(err)) return;
    if (threadList.mailboxId !== mailboxId) return;
    // A pagination failure keeps the already-loaded rows; only flag a retryable footer.
    setThreadList({
      loading: false,
      loadMoreError: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- Reading pane: the currently open conversation -------------------------

export interface ThreadState {
  threadId: string | null;
  /** Email ids in the thread, oldest-first (as Thread/get returns them). */
  emailIds: string[];
  loading: boolean;
  error: string | null;
}

export const [thread, setThread] = createStore<ThreadState>({
  threadId: null,
  emailIds: [],
  loading: false,
  error: null,
});

/**
 * Load a full conversation: Thread/get for its email ids, then Email/get for those
 * ids with full headers + body (one round trip via a #ids back-reference).
 */
export async function loadThread(threadId: string): Promise<void> {
  setThread({ threadId, emailIds: [], loading: true, error: null });
  try {
    const client = jmap();
    const responses = await client.request([
      threadGet(client.accountId, "t", { ids: [threadId] }),
      emailGet(client.accountId, "e", {
        idsRef: { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: DETAIL_PROPERTIES,
        // Fetch both so selectBody's text fallback works for messages with no HTML part.
        fetchHTMLBodyValues: true,
        fetchTextBodyValues: true,
      }),
    ]);
    const threadResult = methodResult(responses, "t");
    const getResult = methodResult(responses, "e");
    cacheEmails((getResult.list ?? []) as Email[]);
    rememberEmailState(getResult);
    if (thread.threadId !== threadId) return; // superseded by a newer selection
    const list = (threadResult.list ?? []) as Array<{ id: string; emailIds: string[] }>;
    setThread({ emailIds: list[0]?.emailIds ?? [], loading: false });
    // D1: mark the conversation's shown-and-unread messages read now that it's open. Runs
    // synchronously off the freshly-set thread state, so a manual "mark unread" can only come
    // after (and thus win); the markSeen request itself is fire-and-forget.
    autoMarkThreadRead(threadId);
  } catch (err) {
    if (handleAuthFailure(err)) return;
    if (thread.threadId !== threadId) return;
    setThread({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// --- Incremental sync (driven by push state changes) -----------------------

/**
 * Apply an Email/queryChanges delta to an ordered id list: drop removed ids, then
 * splice each added id at its index (ascending, per RFC 8620 §5.6). Pure + tested.
 */
export function applyQueryChanges(
  ids: string[],
  removed: string[],
  added: Array<{ id: string; index: number }>,
): string[] {
  const removedSet = new Set(removed);
  const result = ids.filter((id) => !removedSet.has(id));
  for (const item of [...added].sort((a, b) => a.index - b.index)) {
    const at = Math.min(Math.max(item.index, 0), result.length);
    result.splice(at, 0, item.id);
  }
  return result;
}

/** Patch the open folder's list from the server delta instead of refetching it. */
export async function syncThreadList(): Promise<void> {
  const mailboxId = threadList.mailboxId;
  if (!mailboxId || !threadList.queryState) return;
  const client = jmap();
  // Bound the delta to the window we actually hold so changes past it don't reorder us.
  // With an empty window (e.g. mail arriving in an open, empty folder) omit upToId so
  // queryChanges still reports the additions instead of being skipped entirely.
  const upToId = threadList.ids.length > 0 ? threadList.ids[threadList.ids.length - 1] : undefined;
  try {
    const responses = await client.request([
      emailQueryChanges(client.accountId, threadList.queryState, "qc", {
        mailboxId,
        collapseThreads: true,
        upToId,
      }),
    ]);
    const qc = methodResult(responses, "qc");
    const removed = (qc.removed ?? []) as string[];
    const added = (qc.added ?? []) as Array<{ id: string; index: number }>;
    const newQueryState = (qc.newQueryState ?? threadList.queryState) as string;

    // Fetch list properties for any newly-added conversations we don't have cached.
    const missing = added.map((a) => a.id).filter((id) => !emails[id]);
    if (missing.length > 0) {
      const got = await client.request([
        emailGet(client.accountId, "g", { ids: missing, properties: LIST_PROPERTIES }),
      ]);
      cacheEmails((methodResult(got, "g").list ?? []) as Email[]);
    }
    if (threadList.mailboxId !== mailboxId) return;
    setThreadList({
      ids: applyQueryChanges(threadList.ids, removed, added),
      queryState: newQueryState,
    });
  } catch (err) {
    if (handleAuthFailure(err)) return;
    // cannotCalculateChanges (or transient failure) → rebuild the list in place,
    // preserving the reading-pane selection (openMailbox would clear it).
    if (threadList.mailboxId === mailboxId) void reloadThreadList(mailboxId);
  }
}

/** Refresh already-cached emails whose state changed (e.g. $seen toggled elsewhere). */
export async function syncEmails(): Promise<void> {
  if (!emailState) return;
  const client = jmap();
  let result: Awaited<ReturnType<typeof drainChanges>>;
  try {
    // Email/changes is windowed (hasMoreChanges); drainChanges follows it to the latest
    // state. The cursor only advances on full success, so a mid-drain failure re-drains
    // from the same token next time rather than skipping the changes it never applied.
    result = await drainChanges(client, emailState, (sinceState) =>
      emailChanges(client.accountId, sinceState, "ec"),
    );
  } catch (err) {
    if (handleAuthFailure(err)) return;
    return; // a later change or folder switch will resync
  }
  const changed = new Set<string>([...result.created, ...result.updated]);
  const destroyed = result.destroyed;

  // Prune destroyed ids first — it's idempotent, so it's safe to redo if the refetch below
  // fails and the next sync re-drains the same burst.
  if (destroyed.length > 0) {
    const gone = new Set(destroyed);
    setEmails(
      produce((store) => {
        for (const id of destroyed) delete store[id];
      }),
    );
    // Also drop destroyed ids from the visible lists so rows don't linger behind the
    // <Show> guard until the next queryChanges pass — and so loadMore's position
    // (threadList.ids.length) stays accurate.
    if (threadList.ids.some((id) => gone.has(id))) {
      setThreadList("ids", (ids) => ids.filter((id) => !gone.has(id)));
    }
    if (thread.emailIds.some((id) => gone.has(id))) {
      setThread("emailIds", (ids) => ids.filter((id) => !gone.has(id)));
    }
  }

  // Only refresh emails we're actually displaying; new ones arrive via the list sync.
  // Advance the cursor only after the refetch applies: if the Email/get throws, the error
  // propagates to runSync (re-auth on JmapAuthError, log otherwise) with emailState left
  // put, so the next sync re-drains and retries rather than skipping the updated ids.
  const toFetch = [...changed].filter((id) => emails[id]);
  if (toFetch.length > 0) {
    const got = await client.request([
      emailGet(client.accountId, "g", { ids: toFetch, properties: LIST_PROPERTIES }),
    ]);
    cacheEmails((methodResult(got, "g").list ?? []) as Email[]);
  }
  emailState = result.newState;
}

// --- Mutations: optimistic Email/set ---------------------------------------

// Both `keywords` and `mailboxIds` are presence maps (`Record<string, true>`: a key's
// presence means set). Every keyword/mailbox mutation is therefore "set/clear one key" on
// one of those maps, which `Email/set update` expresses as the JSON-pointer patch
// `{"<map>/<key>": true | null}`. Modeling a mutation as a list of these makes one wrapper
// (optimisticEmailUpdate) serve markSeen/setFlagged now and PR 2's move/trash later.
type PresenceMap = "keywords" | "mailboxIds";
interface PresencePatch {
  map: PresenceMap;
  key: string;
  /** true → set the key (pointer = true); false → remove it (pointer = null). */
  present: boolean;
}

function isPresent(email: Email, map: PresenceMap, key: string): boolean {
  return email[map][key] === true;
}

function applyPresence(email: Email, p: PresencePatch): void {
  if (p.present) email[p.map][p.key] = true;
  else delete email[p.map][p.key];
}

/**
 * Optimistically apply presence-map patches to the held emails, issue ONE batched
 * Email/set update for every id, and roll back the rows the server refuses. Reused by every
 * keyword/mailbox mutation.
 *
 * Stale-snapshot discipline (see qelo-review-checklist): a coalesced syncEmails can refetch
 * and overwrite a row across our `await`. So we (a) capture only the *prior presence of the
 * exact fields we touch* per row — never a wholesale snapshot — and (b) on rollback revert a
 * field only if it still holds the value we optimistically wrote; if sync changed it to
 * newer server truth in the meantime, we leave that truth alone. We never advance emailState
 * from this /set — the push-driven drain owns that cursor.
 *
 * Resolves (never rejects) so callers can fire-and-forget: a transport/method failure rolls
 * everything back and is logged; an auth failure raises the re-auth gate.
 *
 * Returns the ids whose optimistic change did NOT persist:
 *   - `reverted` — server-refused (reconciled to truth) or locally reverted on a transport/auth
 *     failure, so a caller layering its own optimistic UI on top (PR 2's threadList.ids prune)
 *     knows which rows to restore. An accepted change yields none.
 *   - `gone` — the subset of `reverted` the server no longer returns at all (destroyed
 *     elsewhere). Their `mailboxIds` was rolled back to the pre-optimistic snapshot only so the
 *     destroy push can prune them, so a caller MUST NOT treat that snapshot as "still here" and
 *     restore a row for them — that would be a ghost row until the next sync.
 *
 * `knownPrior` lets a caller that already optimistically applied a patch to an id (e.g. a
 * pre-patch for instant feedback, before this call) supply that id's TRUE pre-optimistic presence,
 * so the rollback snapshot isn't polluted by reading back the caller's own optimistic write. Only
 * the prior CAPTURE consults it; the optimistic write is still (idempotently) applied to every held
 * id — see mutateConversationKeyword.
 */
async function optimisticEmailUpdate(
  ids: string[],
  patches: PresencePatch[],
  knownPrior?: Map<string, boolean[]>,
): Promise<{ reverted: string[]; gone: string[] }> {
  if (ids.length === 0) return { reverted: [], gone: [] };
  const held = ids.filter((id) => emails[id]);

  // Capture pre-optimistic presence of each patched field, per held row, for a precise revert.
  // A supplied `knownPrior` wins: its id was already optimistically patched by the caller, so the
  // current store value is that optimistic write, not the true prior we must revert to.
  const prior = new Map<string, boolean[]>();
  for (const id of held) {
    const supplied = knownPrior?.get(id);
    if (supplied) {
      prior.set(id, supplied);
      continue;
    }
    const email = emails[id];
    if (email)
      prior.set(
        id,
        patches.map((p) => isPresent(email, p.map, p.key)),
      );
  }

  setEmails(
    produce((store) => {
      for (const id of held) {
        const email = store[id];
        if (!email) continue;
        for (const p of patches) applyPresence(email, p);
      }
    }),
  );

  // The patch object is identical for every id, so build it once.
  const patchObj: EmailPatch = {};
  for (const p of patches) patchObj[`${p.map}/${p.key}`] = p.present ? true : null;
  const update: Record<string, EmailPatch> = {};
  for (const id of ids) update[id] = patchObj;

  let refused: string[];
  try {
    const client = jmap();
    const responses = await client.request([emailSet(client.accountId, "set", { update })]);
    // requireNewState:false — a fully-refused update omits newState (Stalwart), which this path
    // never persists (sync advances emailState via Email/changes); without it setResult would throw
    // on the all-refused case, dropping into the blunt rollback instead of the per-item reconcile.
    refused = Object.keys(setResult(responses, "set", { requireNewState: false }).notUpdated);
  } catch (err) {
    // Unknown server outcome (transport/method-level error, or jmap() after sign-out): we can't
    // refetch (the request itself failed), so revert every row we touched — guarded so we don't
    // clobber a concurrent sync write — and let a later sync reconcile to truth.
    rollbackPresence(held, patches, prior);
    if (!handleAuthFailure(err)) {
      console.error("Email/set update failed:", err);
    }
    // Couldn't refetch, so we don't know which (if any) are gone — treat none as gone.
    return { reverted: held, gone: [] };
  }
  // Per-item refusals (e.g. forbidden / revoked rights): the server kept its own state, so it —
  // not our pre-optimistic snapshot — is the truth. Refetch the refused ids and apply server
  // truth rather than reverting to `prior`: this undoes our optimistic write AND reconciles a
  // concurrent change race-free (the same-value race a local guard can't detect).
  const gone = refused.length > 0 ? await reconcileRefused(refused, patches, prior) : [];
  return { reverted: refused, gone };
}

/**
 * Reconcile rows the server refused: refetch them and apply server truth (authoritative undo of
 * our optimistic write that also absorbs any concurrent change). Ids the server no longer
 * returns are destroyed — revert those to their pre-optimistic value (the destroy push will
 * then prune them). On a refetch failure, fall back to the guarded local revert for all of them.
 * Does NOT advance emailState — like syncEmails' follow-up /get, this is a partial fetch and the
 * push-driven drain owns the cursor.
 *
 * Returns the ids the server no longer returns (destroyed elsewhere). Their reverted snapshot is
 * NOT current truth, so a caller restoring optimistic UI must skip them — see optimisticEmailUpdate.
 */
async function reconcileRefused(
  ids: string[],
  patches: PresencePatch[],
  prior: Map<string, boolean[]>,
): Promise<string[]> {
  let returned: Set<string>;
  try {
    const client = jmap();
    const got = await client.request([
      emailGet(client.accountId, "g", { ids, properties: LIST_PROPERTIES }),
    ]);
    const list = (methodResult(got, "g").list ?? []) as Email[];
    cacheEmails(list); // merge overwrites the row's keywords/mailboxIds with server truth
    returned = new Set(list.map((e) => e.id));
  } catch (err) {
    if (!handleAuthFailure(err)) rollbackPresence(ids, patches, prior);
    return []; // couldn't refetch — we don't know which are gone
  }
  const destroyed = ids.filter((id) => !returned.has(id));
  if (destroyed.length > 0) rollbackPresence(destroyed, patches, prior);
  return destroyed;
}

function rollbackPresence(
  ids: string[],
  patches: PresencePatch[],
  prior: Map<string, boolean[]>,
): void {
  setEmails(
    produce((store) => {
      for (const id of ids) {
        const email = store[id];
        const before = prior.get(id);
        if (!email || !before) continue; // row gone (destroyed by sync) or was never held
        patches.forEach((p, i) => {
          // Only revert if the field still holds the value we optimistically wrote. If a
          // concurrent syncEmails refetched the row and changed it, that's newer server
          // truth — don't clobber it with our stale pre-optimistic value.
          if (isPresent(email, p.map, p.key) !== p.present) return;
          const wasPresent = before[i] ?? false;
          if (wasPresent) email[p.map][p.key] = true;
          else delete email[p.map][p.key];
        });
      }
    }),
  );
}

/** Mark the given emails read/unread ($seen). Optimistic; rolls back any the server refuses. */
export async function markSeen(ids: string[], seen: boolean): Promise<void> {
  await optimisticEmailUpdate(ids, [{ map: "keywords", key: "$seen", present: seen }]);
}

/** Flag/unflag the given emails ($flagged). Optimistic; rolls back any the server refuses. */
export async function setFlagged(ids: string[], flagged: boolean): Promise<void> {
  await optimisticEmailUpdate(ids, [{ map: "keywords", key: "$flagged", present: flagged }]);
}

// --- Mailbox mutations: move / archive / trash / delete --------------------

/** A representative id removed from a visible id list, with where it sat, for a rollback. */
interface PrunedRow {
  id: string;
  index: number;
}

/**
 * Split `current` into the ids that survive a removal and the rows we dropped (id + original
 * index), so a refused mutation can splice them back where they were. Pure + unit-tested.
 */
export function pruneIds(
  current: string[],
  remove: Set<string>,
): { kept: string[]; rows: PrunedRow[] } {
  const rows: PrunedRow[] = [];
  current.forEach((id, index) => {
    if (remove.has(id)) rows.push({ id, index });
  });
  return { kept: current.filter((id) => !remove.has(id)), rows };
}

/**
 * Splice pruned rows back into a (possibly concurrently-changed) id list. Stale-snapshot safe:
 * skips any id the caller no longer wants restored (`allow`) and any already present (a
 * concurrent syncThreadList may have re-added it), and clamps each insert so a shrunk list can't
 * throw. Ascending row order preserves the rows' relative order. Pure + unit-tested.
 */
export function spliceBack(current: string[], rows: PrunedRow[], allow: Set<string>): string[] {
  const have = new Set(current);
  const next = [...current];
  for (const { id, index } of rows) {
    if (!allow.has(id) || have.has(id)) continue;
    have.add(id);
    next.splice(Math.min(index, next.length), 0, id);
  }
  return next;
}

/**
 * Move emails out of the currently-open folder into `toMailboxId`: optimistically patch
 * `mailboxIds` (remove the open folder, add the target) AND drop the moved-away representative
 * rows from the open list, then reconcile. The from-mailbox is the open folder, so a single
 * shared patch serves every id (matching optimisticEmailUpdate's one-patchObj model).
 *
 * Stale-snapshot discipline (qelo-review-checklist): the list prune races a coalesced
 * syncThreadList across the /set await. We capture the open folder + each pruned row's index,
 * and on a refused/failed move re-insert ONLY rows whose server truth still has them in the
 * open folder (`mailboxIds[fromId]`), only while that same folder is still open, and only if
 * sync hasn't already re-added them — never a wholesale revert. We do NOT route through the push
 * coalesce() or advance any cursor; the push-driven sync owns those.
 */
async function optimisticMove(
  ids: string[],
  fromId: string,
  toId: string,
): Promise<{ reverted: string[]; rows: PrunedRow[] }> {
  if (ids.length === 0 || fromId === toId) return { reverted: [], rows: [] };
  const moving = new Set(ids);

  // Optimistically prune the moved representatives from the open list, remembering where they
  // were. fromId is the open folder, so it's also the folder the re-insert re-validates against.
  const { rows } = pruneIds(threadList.ids, moving);
  if (rows.length > 0) setThreadList("ids", (cur) => cur.filter((id) => !moving.has(id)));

  const { reverted, gone } = await optimisticEmailUpdate(ids, [
    { map: "mailboxIds", key: fromId, present: false },
    { map: "mailboxIds", key: toId, present: true },
  ]);

  // Re-insert only rows the move didn't stick for AND that still exist server-side in the
  // from-folder. Exclude `gone` ids: their mailboxIds was reverted to the pre-optimistic snapshot
  // only so the destroy push can prune them — restoring a row for them would be a ghost. A
  // concurrent actor that genuinely moved (not destroyed) it leaves mailboxIds without fromId, so
  // that case is filtered too. Only while that folder is still open.
  if (rows.length > 0 && reverted.length > 0 && threadList.mailboxId === fromId) {
    const goneSet = new Set(gone);
    const restore = new Set(
      reverted.filter((id) => !goneSet.has(id) && emails[id]?.mailboxIds[fromId] === true),
    );
    if (restore.size > 0) setThreadList("ids", (cur) => spliceBack(cur, rows, restore));
  }
  // `rows` lets a caller (moveWithUndo) restore the pruned rows at their original positions on undo.
  // `gone` stays internal (the re-insert guard above) — callers only need reverted + rows.
  return { reverted, rows };
}

/**
 * Move out of the open folder AND offer an Undo toast naming the destination. A misclick in the
 * "Move to…" picker (or archive/trash, which route through here) is one click to reverse. The toast's
 * Undo reverses ONLY the ids the server actually moved — `reverted`/`gone` ids never left, so they're
 * excluded — and feeds undoMove the pruned `rows` so the reversed rows snap back to their old spots.
 * No toast if nothing moved (a no-op or fully-refused move). The undo runs the raw reverse via
 * undoMove (NOT moveWithUndo), so undoing doesn't itself spawn another Undo toast.
 */
async function moveWithUndo(ids: string[], fromId: string, toId: string): Promise<void> {
  // Match optimisticMove's own no-op guard: an empty set or a "move" to the folder it's already in
  // moves nothing, so don't raise a spurious "Moved to X · Undo" toast (whose Undo would then prune
  // live rows for a move that never happened). The picker excludes the current folder, but this is
  // the store boundary — correct regardless of what the UI can reach.
  if (ids.length === 0 || fromId === toId) return;
  const { reverted, rows } = await optimisticMove(ids, fromId, toId);
  const refused = new Set(reverted);
  // Moved = not refused AND still held: optimisticEmailUpdate only ever sends ids it holds in the
  // cache, so an uncached id was never part of the /set — it isn't in `reverted` on a transport
  // failure either, so without the `emails[id]` guard it would look "moved" and raise a toast (whose
  // Undo asserts a state that never existed). A `gone`/destroyed id is uncached too, so it's excluded.
  const moved = ids.filter((id) => !refused.has(id) && emails[id]);
  if (moved.length === 0) return;
  const name = mailboxes[toId]?.name ?? "folder";
  notify(`Moved to ${name}`, {
    label: "Undo",
    run: () => undoMove(moved, fromId, toId, rows),
  });
}

/**
 * Reverse a move: take `ids` back out of `toId` and into `fromId` (their original folder). The
 * inverse of optimisticMove — optimistically RE-INSERTS the pruned rows into the open folder (the
 * undo target) before the round trip so the rows reappear instantly, then reverses the mailboxIds
 * patch; an id whose reverse the server refuses is pruned back out. Stale-snapshot safe like the
 * forward path: only touches the list while `fromId` is still the open folder, and spliceBack skips
 * any id sync already re-added. Raw (no toast) so undo can't loop into another Undo toast.
 *
 * Only reverses ids STILL in `toId`: the toast lives up to 4s, in which the user may move the same
 * conversation onward (B→C). Reversing a superseded move would add `fromId` back while the message
 * sits in C — leaving it in two folders. Filtering to `mailboxIds[toId] === true` makes a stale undo
 * a no-op (the later move wins), and naturally drops uncached/destroyed ids too.
 */
async function undoMove(
  ids: string[],
  fromId: string,
  toId: string,
  rows: PrunedRow[],
): Promise<void> {
  const live = ids.filter((id) => emails[id]?.mailboxIds[toId] === true);
  if (live.length === 0) return;
  const set = new Set(live);
  // Optimistic list update for whichever folder is open: the reversed ids LEAVE toId and RETURN to
  // fromId. Viewing the source → splice their rows back (no `emails[id]` guard: we're ABOUT to re-add
  // fromId, so it isn't set yet — a refused reverse is cleaned up below; index is the move-time slot,
  // clamped by spliceBack and re-sorted by the next sync). Viewing the destination → prune them, else
  // a ghost row lingers in the destination list until the next sync (the ghost-row class).
  if (threadList.mailboxId === fromId && rows.length > 0) {
    setThreadList("ids", (cur) => spliceBack(cur, rows, set));
  } else if (threadList.mailboxId === toId) {
    setThreadList("ids", (cur) => cur.filter((id) => !set.has(id)));
  }
  const { reverted } = await optimisticEmailUpdate(live, [
    { map: "mailboxIds", key: toId, present: false },
    { map: "mailboxIds", key: fromId, present: true },
  ]);
  // A refused reverse means the id didn't move back — undo the optimistic source re-insert. (Viewing
  // the destination, a refused id is still there but we pruned it; we don't hold its destination
  // position to splice back, so the next sync re-adds it — an accepted lag on a rare undo refusal.)
  if (reverted.length > 0 && threadList.mailboxId === fromId) {
    const bounced = new Set(reverted);
    setThreadList("ids", (cur) => cur.filter((id) => !bounced.has(id)));
  }
}

/** Move emails from the open folder into `toMailboxId`. Optimistic; rolls back on refusal. */
export async function moveEmails(ids: string[], toMailboxId: string): Promise<void> {
  const fromId = threadList.mailboxId;
  if (!fromId) return;
  await moveWithUndo(ids, fromId, toMailboxId);
}

/** Archive (D2): move the given emails from the open folder to the archive-role mailbox. */
export async function archive(ids: string[]): Promise<void> {
  const to = mailboxIdByRole("archive");
  if (to) await moveEmails(ids, to);
}

/** Trash (D2 default delete): move the given emails from the open folder to the trash-role mailbox. */
export async function trash(ids: string[]): Promise<void> {
  const to = mailboxIdByRole("trash");
  if (to) await moveEmails(ids, to);
}

/**
 * Delete forever: a hard `Email/set destroy` (D2 — only offered from within Trash). Optimistically
 * drops the rows from the open list AND the reading pane, then on a per-item refusal (or a
 * transport/auth failure) re-inserts exactly the rows the server kept — guarded against a
 * concurrent syncThreadList/syncEmails exactly like a move. Prunes the destroyed ids from the
 * email cache so they vanish at once (idempotent with the destroy push). Resolves, never rejects.
 */
export async function deleteForever(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const removing = new Set(ids);

  // Optimistic list/pane prune, remembering positions for a rollback re-insert. Capture the
  // open folder AND the open conversation so a re-insert can bail if either was superseded
  // across the await (the stale-snapshot class): a folder switch invalidates the list rows, a
  // thread switch invalidates the pane rows — re-inserting then would inject ids into the wrong
  // list. spliceBack additionally skips anything a concurrent sync already re-added.
  const prunedFrom = threadList.mailboxId;
  const prunedThreadId = thread.threadId;
  const listRows = pruneIds(threadList.ids, removing).rows;
  const paneRows = pruneIds(thread.emailIds, removing).rows;
  if (listRows.length > 0) setThreadList("ids", (cur) => cur.filter((id) => !removing.has(id)));
  if (paneRows.length > 0) setThread("emailIds", (cur) => cur.filter((id) => !removing.has(id)));
  const restorePrunedRows = (allow: Set<string>): void => {
    if (listRows.length > 0 && threadList.mailboxId === prunedFrom) {
      setThreadList("ids", (cur) => spliceBack(cur, listRows, allow));
    }
    if (paneRows.length > 0 && thread.threadId === prunedThreadId) {
      setThread("emailIds", (cur) => spliceBack(cur, paneRows, allow));
    }
  };

  // `gone` = ids the server removed; `survived` = ids it refused to destroy and still holds.
  // A `notFound` refusal means the email was already gone (e.g. another client destroyed it),
  // so it counts as gone — keep its row pruned and drop the cache entry — NOT survived. Only a
  // substantive refusal (forbidden, etc.) leaves the email in place and warrants a re-insert.
  const gone = new Set<string>();
  const survived = new Set<string>();
  try {
    const client = jmap();
    const responses = await client.request([emailSet(client.accountId, "set", { destroy: ids })]);
    // requireNewState:false — a fully-refused destroy omits newState (Stalwart); this path syncs via
    // Email/changes, not this token, so tolerate its absence and read the destroyed/notDestroyed maps.
    const r = setResult(responses, "set", { requireNewState: false });
    for (const id of r.destroyed) gone.add(id);
    for (const [id, err] of Object.entries(r.notDestroyed)) {
      if (err.type === "notFound") gone.add(id);
      else survived.add(id);
    }
  } catch (err) {
    // Unknown outcome: restore every pruned row (guarded) and let a later sync reconcile.
    restorePrunedRows(new Set(ids));
    if (!handleAuthFailure(err)) console.error("Email/set destroy failed:", err);
    return;
  }

  // Prune gone ids from the cache (idempotent with the destroy push).
  if (gone.size > 0) {
    setEmails(
      produce((store) => {
        for (const id of gone) delete store[id];
      }),
    );
  }
  // Re-insert rows for emails the server refused to destroy and still holds.
  if (survived.size > 0) restorePrunedRows(survived);
}

// --- Whole-conversation mutations ------------------------------------------
//
// A collapsed list row / dragged conversation is identified by its REPRESENTATIVE email id (the
// one Email/query returns for the thread). The keyword + mailbox primitives above already act on
// any id set, so a whole-conversation action is just "expand the representative into the thread's
// ids, then call the same primitive." Scope (decided with Bill, matching OWA/Gmail/Apple Mail):
//   - keywords (read/unread, flag): the WHOLE conversation — every message in the thread, across
//     every folder.
//   - mailbox ops (move/archive/trash/delete): only the conversation's messages in the OPEN folder
//     — messages already filed elsewhere stay put. This also keeps the optimistic mailboxIds patch
//     correct (patching `mailboxIds/<fromId>: null` on a message not in fromId is a no-op, while
//     `mailboxIds/<toId>: true` would WRONGLY add it to the target).
// The reading pane keeps per-message actions (it shows individual messages), so those still call
// the id-set primitives directly with a single message id.

/**
 * Expand a collapsed thread's representative id into every Email id in its conversation. Prefers
 * the open reading-pane thread (already fully loaded by loadThread — no round trip); otherwise
 * resolves the representative's cached threadId and fetches the thread's email ids together with
 * their list properties (incl. mailboxIds, needed to scope a move to the open folder) in ONE
 * batched request, caching them so the optimistic primitives find them held.
 *
 * Does NOT advance emailState — a partial fetch; the push-driven drain owns that cursor. Falls back
 * to `[repId]` if the conversation can't be resolved (rep not cached, no threadId, or the fetch
 * returns nothing) so the action still hits at least the representative; returns `[]` only on an
 * auth failure (the re-auth gate is raised) so the caller no-ops.
 */
async function conversationEmailIds(repId: string): Promise<string[]> {
  const threadId = emails[repId]?.threadId;
  if (!threadId) return [repId];
  // The open conversation is already fully loaded (Thread/get + detail Email/get in loadThread).
  // Copy it: thread.emailIds is the reactive store array — never hand a caller a live reference.
  if (conversationOpenInPane(threadId)) return [...thread.emailIds];
  try {
    const client = jmap();
    const responses = await client.request([
      threadGet(client.accountId, "t", { ids: [threadId] }),
      emailGet(client.accountId, "g", {
        idsRef: { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
        properties: LIST_PROPERTIES,
      }),
    ]);
    cacheEmails((methodResult(responses, "g").list ?? []) as Email[]);
    const list = (methodResult(responses, "t").list ?? []) as Array<{
      id: string;
      emailIds: string[];
    }>;
    const ids = list[0]?.emailIds ?? [];
    return ids.length > 0 ? ids : [repId];
  } catch (err) {
    if (handleAuthFailure(err)) return [];
    // Any transport/method failure: act on the representative alone rather than nothing.
    return [repId];
  }
}

/**
 * The conversation's email ids currently in the open folder — the move/delete scope. The
 * representative is, by construction, a row from the open folder's collapsed query and is cached
 * with its mailboxIds, so it's in this set in every normal case (and is the only member when the
 * expand fell back to `[repId]` on a fetch failure). An EMPTY result therefore means every thread
 * member — including the representative — left the open folder across the expand await (a concurrent
 * move): the right answer is then to do NOTHING. We deliberately do not fall back to `[repId]` here,
 * which would re-add a message to the move/destroy target it no longer belonged to in `fromId` — the
 * exact wrong-add the scope note above guards against. optimisticMove/deleteForever no-op on `[]`.
 */
async function conversationIdsInOpenFolder(repId: string, fromId: string): Promise<string[]> {
  const ids = await conversationEmailIds(repId);
  return ids.filter((id) => emails[id]?.mailboxIds[fromId] === true);
}

/**
 * True when the representative's conversation is the one currently open in the reading pane, fully
 * loaded — so conversationEmailIds returns its ids WITHOUT a round trip. Shared with the keyword
 * pre-patch gate (mutateConversationKeyword) so the two can't drift on "does this need a fetch".
 */
function conversationOpenInPane(threadId: string): boolean {
  return thread.threadId === threadId && thread.emailIds.length > 0;
}

/**
 * Apply one keyword presence patch to the whole conversation, flipping the visible representative
 * row's indicator IMMEDIATELY when expanding the thread needs a round trip — so a read/flag toggle
 * on a collapsed, not-yet-open multi-message conversation doesn't lag the Thread/get on a slow link
 * (#14, deferred from PR #21).
 *
 * The whole conversation is still mutated by a SINGLE optimisticEmailUpdate (one /set) once the
 * thread is expanded — two /sets on the same representative (a pre-patch /set + the full pass)
 * couldn't coordinate their rollbacks: a transport failure of one while the other persisted would
 * revert the row despite the server accepting the change. Instead, for instant feedback we apply a
 * request-LESS optimistic store write to the representative alone before the expand (the row reads
 * emails[rep], so its indicator flips synchronously). The expand then refetches server truth over
 * the rep (clobbering that pre-patch); the single full pass re-applies the patch to the whole
 * conversation — the clobber and the re-apply land in adjacent microtasks with no paint between, so
 * the row never flickers. Because the pre-patch left our optimistic value in the store (and on an
 * expand FAILURE there's no clobber to reset it), we hand the full pass the rep's TRUE prior via
 * `knownPrior` so a rollback reverts to the pre-optimistic value, not back to our own pre-patch.
 *
 * When the conversation resolves locally (open in the pane, or no threadId) there's no fetch to
 * lag, so we skip the pre-patch and mutate the whole set in a single /set with no `knownPrior`.
 */
async function mutateConversationKeyword(repId: string, patch: PresencePatch): Promise<void> {
  const rep = emails[repId];
  const threadId = rep?.threadId;
  const needsFetch = threadId !== undefined && !conversationOpenInPane(threadId);
  let knownPrior: Map<string, boolean[]> | undefined;
  if (needsFetch && rep) {
    // The rep's pre-optimistic value, captured BEFORE the request-less pre-patch flips it.
    knownPrior = new Map([[repId, [isPresent(rep, patch.map, patch.key)]]]);
    setEmails(
      produce((store) => {
        const email = store[repId];
        if (email) applyPresence(email, patch);
      }),
    );
  }
  const ids = await conversationEmailIds(repId);
  if (ids.length === 0) {
    // conversationEmailIds returns [] ONLY on an auth failure (the re-auth gate is already raised),
    // so the full pass below would no-op and never issue a /set. Roll the request-less pre-patch
    // back (guarded, via the rep's captured prior) instead of stranding an optimistic flip on a row
    // whose change was never sent.
    if (knownPrior) rollbackPresence([repId], [patch], knownPrior);
    return;
  }
  await optimisticEmailUpdate(ids, [patch], knownPrior);
}

/** Mark every message in the representative's conversation read/unread ($seen). Optimistic. */
export async function markConversationSeen(repId: string, seen: boolean): Promise<void> {
  await mutateConversationKeyword(repId, { map: "keywords", key: "$seen", present: seen });
}

/** Flag/unflag every message in the representative's conversation ($flagged). Optimistic. */
export async function setConversationFlagged(repId: string, flagged: boolean): Promise<void> {
  await mutateConversationKeyword(repId, { map: "keywords", key: "$flagged", present: flagged });
}

/**
 * Move the representative's conversation out of the open folder into `toMailboxId`. Only the
 * conversation's messages currently in the open folder are moved (see scope note above). Captures
 * the open folder synchronously (before the expand await) so a folder switch mid-expand can't
 * retarget the move; optimisticMove then owns the optimistic prune + reconcile.
 */
export async function moveConversation(repId: string, toMailboxId: string): Promise<void> {
  const fromId = threadList.mailboxId;
  if (!fromId) return;
  await moveWithUndo(await conversationIdsInOpenFolder(repId, fromId), fromId, toMailboxId);
}

/** Archive the representative's conversation (open folder → archive-role mailbox). */
export async function archiveConversation(repId: string): Promise<void> {
  const to = mailboxIdByRole("archive");
  if (to) await moveConversation(repId, to);
}

/** Trash the representative's conversation (open folder → trash-role mailbox). */
export async function trashConversation(repId: string): Promise<void> {
  const to = mailboxIdByRole("trash");
  if (to) await moveConversation(repId, to);
}

/**
 * Delete forever every message of the conversation that's in the open (Trash) folder. Like
 * deleteForever, a hard Email/set destroy — scoped to the open folder per Bill's decision, so a
 * message that also lives in another folder isn't destroyed from under it.
 */
export async function deleteConversationForever(repId: string): Promise<void> {
  const fromId = threadList.mailboxId;
  if (!fromId) return;
  await deleteForever(await conversationIdsInOpenFolder(repId, fromId));
}

/**
 * Auto-mark-read on open (D1): flip the just-opened conversation's shown-and-unread messages
 * to $seen. Fires once per open (loadThread only re-runs when the selected thread changes),
 * only for the still-current selection, only for messages we actually hold and that are
 * actually unread, and only when the open folder grants maySetSeen. A later explicit "mark
 * unread" is a separate user action that simply wins — nothing here re-triggers it.
 */
function autoMarkThreadRead(threadId: string): void {
  // Gate on the live UI selection, not `thread.threadId`: navigating away (a mailbox switch
  // clears selectedThreadId) doesn't reset the `thread` store, so `thread.threadId` can still
  // equal `threadId` after the user has left — auto-marking a thread they no longer have open.
  // selectedThreadId is the source of truth for "still showing this conversation".
  if (selectedThreadId() !== threadId) return;
  if (!selectedMailboxRights()?.maySetSeen) return;
  const unread = thread.emailIds.filter((id) => emails[id] && !emails[id]?.keywords.$seen);
  if (unread.length === 0) return;
  // Fire-and-forget: markSeen is self-contained (optimistic + rollback) and never rejects.
  void markSeen(unread, true);
}
