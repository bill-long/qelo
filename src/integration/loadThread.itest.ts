import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Id } from "@/jmap/types";
import { emails, loadThread, thread } from "@/stores/emails";
import {
  connectTestClient,
  createMailbox,
  createThread,
  destroyMailbox,
  disconnectTestClient,
  resetStores,
  testClient,
} from "./harness";

// loadThread batches Thread/get → Email/get (DETAIL_PROPERTIES) via a #ids back-reference
// in one round trip, and the reading pane relies on the returned order being oldest-first.
describe("loadThread (Thread/get → Email/get detail)", () => {
  // Cleared first so a setup failure can't leave a stale id that teardown would try (and
  // fail) to destroy, masking the real error.
  let mailboxId: Id = "";

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(async () => {
    resetStores();
    mailboxId = "";
    mailboxId = await createMailbox(`itest-thread-${Date.now()}`);
  });
  afterEach(async () => {
    if (mailboxId) await destroyMailbox(mailboxId);
  });

  it("loads every message in the thread, oldest-first, in one batched request", async () => {
    const msgs = await createThread(mailboxId, 3);
    const threadId = msgs[0]?.threadId as Id;
    // All messages of one reply chain share a thread.
    expect(new Set(msgs.map((m) => m.threadId)).size).toBe(1);

    testClient().requestCount = 0;
    await loadThread(threadId);

    expect(thread.error).toBeNull();
    expect(thread.threadId).toBe(threadId);
    // Oldest-first (createThread builds the chain oldest-first, matching Thread/get).
    expect(thread.emailIds).toEqual(msgs.map((m) => m.id));
    expect(testClient().requestCount).toBe(1);
  });

  it("caches full bodies (DETAIL_PROPERTIES) for the reading pane", async () => {
    const msgs = await createThread(mailboxId, 2);
    const threadId = msgs[0]?.threadId as Id;

    await loadThread(threadId);

    for (const { id } of msgs) {
      const email = emails[id];
      expect(email).toBeDefined();
      // bodyValues + textBody/htmlBody come only from the DETAIL fetch, not the list fetch.
      expect(email?.bodyValues).toBeDefined();
      expect(Object.keys(email?.bodyValues ?? {}).length).toBeGreaterThan(0);
    }
  });
});
