import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Id } from "@/jmap/types";
import {
  loadMore,
  openMailbox,
  setPageSize,
  setThreadList,
  syncEmails,
  threadList,
} from "@/stores/emails";
import {
  connectTestClient,
  createMailbox,
  createMessages,
  destroyEmails,
  destroyMailbox,
  disconnectTestClient,
  resetStores,
  settleConversations,
  testClient,
} from "./harness";

// The anchor-windowing recovery paths from PR #4 — deliberately not unit-tested (that would
// need a mocked client) and only verifiable against a real server's anchorNotFound behaviour.
describe("loadMore recovery paths", () => {
  // Cleared in beforeEach so a setup/seed failure can't leave a stale id that teardown would
  // try (and fail) to destroy, masking the real error.
  let mailboxId: Id = "";

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(() => {
    resetStores();
    mailboxId = "";
  });

  // Seed `count` standalone conversations and return their settled newest-first order.
  async function seed(count: number): Promise<Id[]> {
    mailboxId = await createMailbox(`itest-recover-${Date.now()}`);
    await createMessages(
      mailboxId,
      Array.from({ length: count }, (_, i) => ({ subject: `Msg ${i}` })),
    );
    setPageSize(2);
    return settleConversations(mailboxId, count);
  }
  afterEach(async () => {
    if (mailboxId) await destroyMailbox(mailboxId);
  });

  it("drops a vanished anchor and re-anchors on the previous row (anchorNotFound)", async () => {
    const order = await seed(5);
    await openMailbox(mailboxId);
    expect(threadList.ids).toEqual(order.slice(0, 2)); // [m0, m1]

    // Remove the tail server-side WITHOUT syncing, so our window still holds it as the
    // anchor. The next loadMore anchors on it, gets anchorNotFound, drops it, re-anchors.
    await destroyEmails([order[1] as string]);
    await settleConversations(mailboxId, 4); // let the query reflect the deletion

    await loadMore();

    // m1 dropped; paging resumed after m0 → next two live rows appended.
    expect(threadList.ids).toEqual([order[0], order[2], order[3]]);
    expect(threadList.loadMoreError).toBeNull();
  });

  it("falls back to a position:0 fetch when sync prunes the window empty", async () => {
    const order = await seed(3);
    await openMailbox(mailboxId);
    expect(threadList.ids).toEqual(order.slice(0, 2)); // [m0, m1], reachedEnd false
    expect(threadList.reachedEnd).toBe(false);

    // Destroy both held rows, then let syncEmails prune them from the window → it goes empty
    // while reachedEnd is still false. loadMore then has nothing to anchor on.
    await destroyEmails([order[0] as string, order[1] as string]);
    await settleConversations(mailboxId, 1);
    await syncEmails();
    expect(threadList.ids).toEqual([]);

    await loadMore();

    // The position:0 fallback re-fetches the first page so paging can resume.
    expect(threadList.ids).toEqual([order[2]]);
    expect(threadList.reachedEnd).toBe(true);
  });

  it("does not append a page computed from an anchor a concurrent sync moved", async () => {
    const order = await seed(5);
    await openMailbox(mailboxId);
    expect(threadList.ids).toEqual(order.slice(0, 2)); // anchor will be m1

    // Simulate a coalesced syncThreadList landing across loadMore's await: it changes the
    // tail we anchored on. The fetched page no longer starts strictly after the current
    // tail, so appendPage must discard it rather than create a gap/disorder.
    testClient().runBeforeNextRequest(() => {
      setThreadList("ids", (ids) => [...ids, "phantom-tail"]);
    });

    await loadMore();

    // The real next page (m2, m3) was NOT appended; only our injected change is present.
    expect(threadList.ids).toEqual([order[0], order[1], "phantom-tail"]);
    expect(threadList.ids).not.toContain(order[2]);
  });

  it("does not drop a tail a concurrent sync legitimately replaced (dead-anchor guard)", async () => {
    const order = await seed(5);
    await openMailbox(mailboxId);
    expect(threadList.ids).toEqual(order.slice(0, 2)); // anchor m1

    // Make the anchor vanish (→ anchorNotFound) AND have a concurrent sync replace the tail
    // across the await. loadMore must not delete the new tail — it's a valid row sync placed.
    await destroyEmails([order[1] as string]);
    await settleConversations(mailboxId, 4);
    testClient().runBeforeNextRequest(() => {
      setThreadList("ids", (ids) => {
        const next = [...ids];
        next[next.length - 1] = "replacement-tail";
        return next;
      });
    });

    await loadMore();

    expect(threadList.ids).toContain("replacement-tail");
    expect(threadList.ids).toEqual([order[0], "replacement-tail"]);
  });
});
