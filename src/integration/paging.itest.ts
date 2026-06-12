import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Id } from "@/jmap/types";
import { loadMore, openMailbox, setPageSize, threadList } from "@/stores/emails";
import {
  connectTestClient,
  createMailbox,
  createMessages,
  destroyMailbox,
  disconnectTestClient,
  resetStores,
  settleConversations,
} from "./harness";

// loadMore pages by anchoring on the last held id (anchorOffset:1), so the page boundary is
// a concrete id rather than an unstable absolute position. With a shrunk page size the small
// seeded dataset spans several pages.
describe("loadMore (anchor paging)", () => {
  let mailboxId: string;
  // Canonical newest-first order of the 5 seeded conversations, as the server's sort reports
  // once indexing settles — the order openMailbox/loadMore page through.
  let order: Id[];

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(async () => {
    resetStores();
    mailboxId = await createMailbox(`itest-page-${Date.now()}`);
    await createMessages(
      mailboxId,
      Array.from({ length: 5 }, (_, i) => ({ subject: `Msg ${i}` })),
    );
    order = await settleConversations(mailboxId, 5);
    setPageSize(2);
  });
  afterEach(async () => {
    await destroyMailbox(mailboxId);
  });

  it("walks every page in order, then terminates on the short final page", async () => {
    await openMailbox(mailboxId);
    expect(threadList.ids).toEqual(order.slice(0, 2));
    expect(threadList.reachedEnd).toBe(false);

    await loadMore();
    expect(threadList.ids).toEqual(order.slice(0, 4));
    expect(threadList.reachedEnd).toBe(false);

    await loadMore();
    // Final page holds a single row (5 % 2), so it's short → reachedEnd.
    expect(threadList.ids).toEqual(order);
    expect(threadList.reachedEnd).toBe(true);
  });

  it("is a no-op once the end is reached", async () => {
    await openMailbox(mailboxId);
    await loadMore();
    await loadMore();
    expect(threadList.reachedEnd).toBe(true);

    await loadMore();
    expect(threadList.ids).toEqual(order);
  });

  it("never produces duplicate ids across page boundaries", async () => {
    await openMailbox(mailboxId);
    await loadMore();
    await loadMore();
    expect(new Set(threadList.ids).size).toBe(threadList.ids.length);
  });
});
