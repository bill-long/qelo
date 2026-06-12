import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Id } from "@/jmap/types";
import { openMailbox, threadList } from "@/stores/emails";
import {
  connectTestClient,
  createMailbox,
  createMessages,
  createThread,
  destroyMailbox,
  disconnectTestClient,
  isCached,
  resetStores,
  settleConversations,
  testClient,
} from "./harness";

// openMailbox must issue ONE batched request (Email/query → Email/get via #ids back-ref) and
// collapse threads to one row per conversation — the core Phase 4 round trip.
describe("openMailbox (batched query→get, collapseThreads)", () => {
  let mailboxId: Id;

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(async () => {
    resetStores();
    mailboxId = await createMailbox(`itest-open-${Date.now()}`);
  });
  afterEach(async () => {
    await destroyMailbox(mailboxId);
  });

  it("collapses a multi-message thread to a single conversation row", async () => {
    // 4 emails across 3 conversations: one 2-message thread + two standalone messages.
    await createThread(mailboxId, 2);
    await createMessages(mailboxId, [{ subject: "Standalone A" }, { subject: "Standalone B" }]);
    await settleConversations(mailboxId, 3);

    testClient().requestCount = 0;
    await openMailbox(mailboxId);

    expect(threadList.error).toBeNull();
    expect(threadList.mailboxId).toBe(mailboxId);
    // 3 collapsed conversations, not 4 messages.
    expect(threadList.ids).toHaveLength(3);
    // Single batched round trip — the whole point of the query→get back-reference.
    expect(testClient().requestCount).toBe(1);
  });

  it("caches list properties for every row it returns", async () => {
    await createMessages(mailboxId, [
      { subject: "First", from: { name: "Ada", email: "ada@example.test" } },
      { subject: "Second" },
    ]);
    await settleConversations(mailboxId, 2);

    await openMailbox(mailboxId);

    expect(threadList.ids).toHaveLength(2);
    for (const id of threadList.ids) {
      expect(isCached(id)).toBe(true);
    }
  });

  it("opens an empty mailbox cleanly (no rows, reachedEnd, no error)", async () => {
    await openMailbox(mailboxId);

    expect(threadList.ids).toEqual([]);
    expect(threadList.reachedEnd).toBe(true);
    expect(threadList.error).toBeNull();
    expect(threadList.loading).toBe(false);
  });
});
