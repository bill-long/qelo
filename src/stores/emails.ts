import { createStore, produce } from "solid-js/store";
import {
  DETAIL_PROPERTIES,
  emailChanges,
  emailGet,
  emailQuery,
  emailQueryChanges,
  idsFromQuery,
  LIST_PROPERTIES,
  methodResult,
  threadGet,
} from "@/jmap/methods";
import type { Email } from "@/jmap/types";
import { jmap } from "./account";
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

const PAGE_SIZE = 50;

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
 * One round trip: query the collapsed conversations for a window, then fetch the list
 * properties of exactly those ids via a #ids back-reference.
 */
async function fetchPage(mailboxId: string, position: number) {
  const client = jmap();
  const responses = await client.request([
    emailQuery(client.accountId, "q", {
      mailboxId,
      collapseThreads: true,
      position,
      limit: PAGE_SIZE,
    }),
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
    reachedEnd: ids.length < PAGE_SIZE,
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
    const page = await fetchPage(mailboxId, 0);
    // A newer selection may have superseded this load mid-flight; if so, discard it.
    if (threadList.mailboxId !== mailboxId) return;
    setThreadList({
      ids: page.ids,
      queryState: page.queryState,
      reachedEnd: page.reachedEnd,
      loading: false,
    });
  } catch (err) {
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
    const page = await fetchPage(mailboxId, 0);
    if (threadList.mailboxId !== mailboxId) return;
    setThreadList({ ids: page.ids, queryState: page.queryState, reachedEnd: page.reachedEnd });
  } catch {
    // Keep the existing rows; a later push or folder switch will retry.
  }
}

/** Append the next page for the current mailbox (infinite scroll). */
export async function loadMore(): Promise<void> {
  const mailboxId = threadList.mailboxId;
  if (!mailboxId || threadList.loading || threadList.error || threadList.reachedEnd) return;
  setThreadList({ loading: true, loadMoreError: null });
  try {
    const page = await fetchPage(mailboxId, threadList.ids.length);
    if (threadList.mailboxId !== mailboxId) return;
    setThreadList(
      produce((s) => {
        const have = new Set(s.ids);
        for (const id of page.ids) if (!have.has(id)) s.ids.push(id);
        s.reachedEnd = page.reachedEnd;
        s.loading = false;
      }),
    );
  } catch (err) {
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
  if (!mailboxId || !threadList.queryState || threadList.ids.length === 0) return;
  const client = jmap();
  // Bound the delta to the window we actually hold, so changes past it don't reorder us.
  const upToId = threadList.ids[threadList.ids.length - 1];
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
  } catch {
    // cannotCalculateChanges (or transient failure) → rebuild the list in place,
    // preserving the reading-pane selection (openMailbox would clear it).
    if (threadList.mailboxId === mailboxId) void reloadThreadList(mailboxId);
  }
}

/** Refresh already-cached emails whose state changed (e.g. $seen toggled elsewhere). */
export async function syncEmails(): Promise<void> {
  if (!emailState) return;
  const client = jmap();
  const changed = new Set<string>();
  const destroyed: string[] = [];
  try {
    // Drain all pending changes: Email/changes is windowed (hasMoreChanges), so one
    // call can return only part of a large burst. The guard caps pathological loops.
    let more = true;
    for (let guard = 0; more && guard < 100; guard += 1) {
      const responses = await client.request([emailChanges(client.accountId, emailState, "ec")]);
      const ec = methodResult(responses, "ec");
      for (const id of (ec.created ?? []) as string[]) changed.add(id);
      for (const id of (ec.updated ?? []) as string[]) changed.add(id);
      for (const id of (ec.destroyed ?? []) as string[]) destroyed.push(id);
      emailState = (ec.newState ?? emailState) as string;
      more = ec.hasMoreChanges === true;
    }
  } catch {
    return; // a later change or folder switch will resync
  }

  // Only refresh emails we're actually displaying; new ones arrive via the list sync.
  const toFetch = [...changed].filter((id) => emails[id]);
  if (toFetch.length > 0) {
    const got = await client.request([
      emailGet(client.accountId, "g", { ids: toFetch, properties: LIST_PROPERTIES }),
    ]);
    cacheEmails((methodResult(got, "g").list ?? []) as Email[]);
  }
  if (destroyed.length > 0) {
    setEmails(
      produce((store) => {
        for (const id of destroyed) delete store[id];
      }),
    );
  }
}
