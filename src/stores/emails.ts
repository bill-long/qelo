import { createStore, produce } from "solid-js/store";
import {
  DETAIL_PROPERTIES,
  emailGet,
  emailQuery,
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

function cacheEmails(list: Email[]): void {
  setEmails(
    produce((store) => {
      for (const email of list) store[email.id] = email;
    }),
  );
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
    if (thread.threadId !== threadId) return; // superseded by a newer selection
    const list = (threadResult.list ?? []) as Array<{ id: string; emailIds: string[] }>;
    setThread({ emailIds: list[0]?.emailIds ?? [], loading: false });
  } catch (err) {
    if (thread.threadId !== threadId) return;
    setThread({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}
