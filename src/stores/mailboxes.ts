import { createStore, produce, reconcile } from "solid-js/store";
import { drainChanges } from "@/jmap/changes";
import { mailboxChanges, mailboxGet, methodResult } from "@/jmap/methods";
import type { Mailbox, MailboxRole } from "@/jmap/types";
import { handleAuthFailure, jmap } from "./account";
import { selectedMailboxId, setSelectedMailboxId } from "./ui";

export const [mailboxes, setMailboxes] = createStore<Record<string, Mailbox>>({});

// Mailbox state token (from /get and /changes responses), used as the `sinceState` for
// Mailbox/changes. Plain module state — it's a sync cursor, not reactive UI state.
let mailboxState = "";

/** Fetch all mailboxes for the account and replace the store. */
export async function loadMailboxes(): Promise<void> {
  const client = jmap();
  const responses = await client.request([mailboxGet(client.accountId, "mb")]);
  const result = methodResult(responses, "mb");
  const list = (result.list ?? []) as Mailbox[];
  if (typeof result.state === "string") mailboxState = result.state;
  const byId: Record<string, Mailbox> = {};
  for (const m of list) byId[m.id] = m;
  // reconcile keeps referential stability for unchanged rows, so only mailboxes whose
  // fields actually changed (e.g. unread counts) trigger re-renders.
  setMailboxes(reconcile(byId));

  // Land on the inbox by default so the conversation list isn't empty on launch.
  if (!selectedMailboxId()) {
    const inbox = list.find((m) => m.role === "inbox");
    if (inbox) setSelectedMailboxId(inbox.id);
  }
}

/**
 * Apply server-pushed mailbox changes incrementally: drain Mailbox/changes for the
 * created/updated/destroyed ids, refetch just the changed ones, and upsert/remove them —
 * rather than reloading the whole folder list on every Mailbox state change. Falls back
 * to a full {@link loadMailboxes} when there's no baseline cursor or the server can't
 * calculate changes (e.g. cannotCalculateChanges after a long gap).
 */
export async function syncMailboxes(): Promise<void> {
  if (!mailboxState) {
    // No baseline cursor yet — a full load both populates the store and captures it.
    await loadMailboxes();
    return;
  }
  const client = jmap();
  let result: Awaited<ReturnType<typeof drainChanges>>;
  try {
    result = await drainChanges(client, mailboxState, (sinceState) =>
      mailboxChanges(client.accountId, sinceState, "mc"),
    );
  } catch (err) {
    if (handleAuthFailure(err)) return;
    // cannotCalculateChanges (or a transient failure) → rebuild the whole list, which
    // also resets the cursor to a usable baseline.
    await loadMailboxes();
    return;
  }
  // Only advance the cursor once the drain fully succeeded.
  mailboxState = result.newState;

  const destroyed = new Set(result.destroyed);
  // Refetch created + updated, minus any id also destroyed in the same burst (destroyed wins).
  const changed = new Set<string>();
  for (const id of [...result.created, ...result.updated]) {
    if (!destroyed.has(id)) changed.add(id);
  }

  if (changed.size > 0) {
    try {
      const got = await client.request([mailboxGet(client.accountId, "mb", { ids: [...changed] })]);
      const list = (methodResult(got, "mb").list ?? []) as Mailbox[];
      // Upsert only the changed rows (don't advance mailboxState from this /get: it can be
      // newer than what we drained, which would skip the changes in between).
      setMailboxes(
        produce((store) => {
          for (const m of list) store[m.id] = m;
        }),
      );
    } catch (err) {
      if (handleAuthFailure(err)) return;
      // Keep the existing rows; a later push or folder switch will refresh them.
    }
  }
  if (destroyed.size > 0) {
    setMailboxes(
      produce((store) => {
        for (const id of destroyed) delete store[id];
      }),
    );
  }
}

export interface MailboxNode {
  mailbox: Mailbox;
  children: MailboxNode[];
}

// Standard roles surface first and in a familiar order; everything else falls through
// to its server-provided sortOrder, then name.
const ROLE_RANK: Partial<Record<MailboxRole, number>> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  trash: 5,
};

function rank(role: MailboxRole | null): number {
  return (role && ROLE_RANK[role]) ?? 99;
}

function compareMailboxes(a: Mailbox, b: Mailbox): number {
  const byRole = rank(a.role) - rank(b.role);
  if (byRole !== 0) return byRole;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

// Walking up from `parentId`, would re-attaching `nodeId` under it close a loop? True
// if `nodeId` is itself somewhere in the parent chain (a malformed, cyclic response).
function formsCycle(nodes: Map<string, MailboxNode>, nodeId: string, parentId: string): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = parentId;
  while (current) {
    if (current === nodeId) return true;
    // A pre-existing cycle among the ancestors that does NOT pass through nodeId: since
    // we check each distinct ancestor against nodeId before adding it to `seen`, reaching
    // a repeat means nodeId is not in the chain. Attaching node here adds no new cycle
    // through it, so it's safe (the cyclic ancestors are themselves promoted to roots when
    // processed). Return false rather than true, and stop to avoid looping forever.
    if (seen.has(current)) return false;
    seen.add(current);
    current = nodes.get(current)?.mailbox.parentId;
  }
  return false;
}

/**
 * Build the parent/child mailbox tree from the flat list. A mailbox whose parentId is
 * null, points at a mailbox not in the list, or would form a cycle becomes a root — so
 * a malformed response never silently drops folders. Each level is sorted by role,
 * then sortOrder, then name.
 */
export function buildMailboxTree(list: Mailbox[]): MailboxNode[] {
  const nodes = new Map<string, MailboxNode>();
  for (const mailbox of list) nodes.set(mailbox.id, { mailbox, children: [] });

  const roots: MailboxNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.mailbox.parentId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parentId && parent && !formsCycle(nodes, node.mailbox.id, parentId)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortLevel = (level: MailboxNode[]) => {
    level.sort((a, b) => compareMailboxes(a.mailbox, b.mailbox));
    for (const node of level) sortLevel(node.children);
  };
  sortLevel(roots);
  return roots;
}
