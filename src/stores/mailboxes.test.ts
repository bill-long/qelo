import { describe, expect, it } from "vitest";
import type { Mailbox } from "@/jmap/types";
import { buildMailboxTree } from "./mailboxes";

/** Build a Mailbox with sensible defaults; override only what a test cares about. */
function mb(p: Partial<Mailbox> & { id: string }): Mailbox {
  return {
    name: p.id,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    ...p,
  };
}

describe("buildMailboxTree", () => {
  it("nests children under their parent and keeps parentless mailboxes as roots", () => {
    const tree = buildMailboxTree([
      mb({ id: "p", name: "Parent" }),
      mb({ id: "c", name: "Child", parentId: "p" }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.mailbox.id).toBe("p");
    expect(tree[0]?.children.map((n) => n.mailbox.id)).toEqual(["c"]);
  });

  it("orders by role, then sortOrder, then name", () => {
    const tree = buildMailboxTree([
      mb({ id: "a", role: null, sortOrder: 2, name: "Beta" }),
      mb({ id: "b", role: null, sortOrder: 1, name: "Gamma" }),
      mb({ id: "c", role: "inbox", sortOrder: 9, name: "Inbox" }),
      mb({ id: "d", role: null, sortOrder: 1, name: "Alpha" }),
    ]);
    // inbox first (role rank), then sortOrder 1 (Alpha before Gamma by name), then sortOrder 2.
    expect(tree.map((n) => n.mailbox.id)).toEqual(["c", "d", "b", "a"]);
  });

  it("treats a mailbox whose parent is missing as a root", () => {
    const tree = buildMailboxTree([mb({ id: "x", parentId: "ghost" })]);
    expect(tree.map((n) => n.mailbox.id)).toEqual(["x"]);
  });

  it("promotes cyclic mailboxes to roots instead of dropping them", () => {
    const tree = buildMailboxTree([
      mb({ id: "a", name: "A", parentId: "b" }),
      mb({ id: "b", name: "B", parentId: "a" }),
    ]);
    // A malformed cycle must not silently vanish, nor recurse forever.
    expect(tree.map((n) => n.mailbox.id).sort()).toEqual(["a", "b"]);
    expect(tree.every((n) => n.children.length === 0)).toBe(true);
  });

  it("sorts nested levels too", () => {
    const tree = buildMailboxTree([
      mb({ id: "p", name: "Parent" }),
      mb({ id: "c2", name: "Zeta", parentId: "p", sortOrder: 1 }),
      mb({ id: "c1", name: "Alpha", parentId: "p", sortOrder: 1 }),
    ]);
    expect(tree[0]?.children.map((n) => n.mailbox.id)).toEqual(["c1", "c2"]);
  });
});
