import { createStore, produce } from "solid-js/store";
import { drainChanges } from "@/jmap/changes";
import {
  DETAIL_PROPERTIES,
  type EmailQueryOptions,
  emailChanges,
  emailGet,
  emailQuery,
  emailQueryChanges,
  idsFromQuery,
  JmapMethodError,
  LIST_PROPERTIES,
  methodResult,
  threadGet,
} from "@/jmap/methods";
import type { Email } from "@/jmap/types";
import { handleAuthFailure, jmap } from "./account";
import { setSelectedEmailId, setSelectedThreadId } from "./ui";

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
