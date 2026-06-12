import { createStore, reconcile } from "solid-js/store";
import { mailboxGet, methodResult } from "@/jmap/methods";
import type { Mailbox, MailboxRole } from "@/jmap/types";
import { jmap } from "./account";

export const [mailboxes, setMailboxes] = createStore<Record<string, Mailbox>>({});

/** Fetch all mailboxes for the account and replace the store. */
export async function loadMailboxes(): Promise<void> {
  const client = jmap();
  const responses = await client.request([mailboxGet(client.accountId, "mb")]);
  const result = methodResult(responses, "mb");
  const list = (result.list ?? []) as Mailbox[];
  const byId: Record<string, Mailbox> = {};
  for (const m of list) byId[m.id] = m;
  // reconcile keeps referential stability for unchanged rows, so only mailboxes whose
  // fields actually changed (e.g. unread counts) trigger re-renders.
  setMailboxes(reconcile(byId));
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
    if (current === nodeId || seen.has(current)) return true;
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
