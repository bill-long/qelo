import { reconcile } from "solid-js/store";
import { afterEach, describe, expect, it } from "vitest";
import type { Mailbox, MailboxRights } from "@/jmap/types";
import {
  canDropOnMailbox,
  draggingEmailId,
  dropTargetMailboxId,
  endDrag,
  setDraggingEmailId,
  setDropTargetMailboxId,
} from "./drag";
import { setThreadList } from "./emails";
import { setMailboxes } from "./mailboxes";

function rights(p: Partial<MailboxRights> = {}): MailboxRights {
  return {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: true,
    mayRename: true,
    mayDelete: true,
    maySubmit: true,
    ...p,
  };
}

function mb(id: string, myRights: MailboxRights): Mailbox {
  return {
    id,
    name: id,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights,
  };
}

/** Replace the mailboxes store and set which folder is "open" (the move's from-mailbox). */
function setup(open: string | null, ...list: Mailbox[]): void {
  const byId: Record<string, Mailbox> = {};
  for (const m of list) byId[m.id] = m;
  // reconcile so the store is REPLACED, not merged — a bare setMailboxes(byId) leaves keys from a
  // prior test behind (Solid's createStore merges at the root), leaking mailboxes between cases.
  setMailboxes(reconcile(byId));
  setThreadList({ mailboxId: open });
}

afterEach(() => {
  setMailboxes(reconcile({}));
  setThreadList({ mailboxId: null, ids: [] });
  endDrag();
});

describe("canDropOnMailbox", () => {
  it("allows a drop when the open folder may remove and the target may add", () => {
    const src = mb("src", rights({ mayRemoveItems: true }));
    const dst = mb("dst", rights({ mayAddItems: true }));
    setup("src", src, dst);
    expect(canDropOnMailbox(dst)).toBe(true);
  });

  it("rejects a self-drop onto the open folder", () => {
    const src = mb("src", rights());
    setup("src", src);
    expect(canDropOnMailbox(src)).toBe(false);
  });

  it("rejects when the target may not add items", () => {
    const src = mb("src", rights({ mayRemoveItems: true }));
    const dst = mb("dst", rights({ mayAddItems: false }));
    setup("src", src, dst);
    expect(canDropOnMailbox(dst)).toBe(false);
  });

  it("rejects when the open folder may not remove items", () => {
    const src = mb("src", rights({ mayRemoveItems: false }));
    const dst = mb("dst", rights({ mayAddItems: true }));
    setup("src", src, dst);
    expect(canDropOnMailbox(dst)).toBe(false);
  });

  it("rejects when no folder is open", () => {
    const dst = mb("dst", rights());
    setup(null, dst);
    expect(canDropOnMailbox(dst)).toBe(false);
  });
});

describe("draggingEmailId", () => {
  it("round-trips the dragged id and clears back to null", () => {
    expect(draggingEmailId()).toBeNull();
    setDraggingEmailId("e1");
    expect(draggingEmailId()).toBe("e1");
    setDraggingEmailId(null);
    expect(draggingEmailId()).toBeNull();
  });

  it("endDrag clears both the dragged id and the lit drop target", () => {
    setDraggingEmailId("e1");
    setDropTargetMailboxId("mb1");
    endDrag();
    expect(draggingEmailId()).toBeNull();
    expect(dropTargetMailboxId()).toBeNull();
  });

  it("does not read a stale source folder from the mailboxes store", () => {
    // canDropOnMailbox must reflect the live open folder, not a captured one.
    const a = mb("a", rights({ mayRemoveItems: true }));
    const b = mb("b", rights({ mayAddItems: true, mayRemoveItems: true }));
    setup("a", a, b);
    expect(canDropOnMailbox(b)).toBe(true);
    // Switch the open folder to b: dropping onto b is now a self-move.
    setThreadList({ mailboxId: "b" });
    expect(canDropOnMailbox(b)).toBe(false);
    expect(canDropOnMailbox(a)).toBe(true);
  });
});
