import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Id } from "@/jmap/types";
import { emails, openMailbox, syncEmails, syncThreadList, threadList } from "@/stores/emails";
import { loadMailboxes, syncMailboxes } from "@/stores/mailboxes";
import {
  connectTestClient,
  createMailbox,
  createMessages,
  destroyEmails,
  destroyMailbox,
  disconnectTestClient,
  isCached,
  mailboxRow,
  resetStores,
  setSeen,
  settleConversations,
} from "./harness";

// Incremental sync (Phase 6): patch the open list/cache from server deltas
// (Email/queryChanges, Email/changes, Mailbox/changes) instead of refetching everything.
describe("incremental sync", () => {
  const mailboxesToClean: Id[] = [];

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(resetStores);
  afterEach(async () => {
    while (mailboxesToClean.length > 0) {
      const id = mailboxesToClean.pop();
      if (id) await destroyMailbox(id).catch(() => {});
    }
  });

  async function freshMailbox(label: string): Promise<Id> {
    const id = await createMailbox(`itest-sync-${label}-${Date.now()}`);
    mailboxesToClean.push(id);
    return id;
  }

  describe("syncThreadList (Email/queryChanges)", () => {
    it("splices a newly-arrived conversation into the open list", async () => {
      const mb = await freshMailbox("add");
      const initial = await createMessages(mb, [{ subject: "One" }, { subject: "Two" }]);
      await settleConversations(mb, 2);
      await openMailbox(mb);
      expect(threadList.ids).toHaveLength(2);

      // New mail lands in the open folder (newest → top of a receivedAt-desc query).
      const [arrived] = await createMessages(mb, [{ subject: "Just arrived" }]);
      await settleConversations(mb, 3);
      await syncThreadList();

      expect(threadList.ids).toHaveLength(3);
      expect(threadList.ids[0]).toBe(arrived?.id);
      expect(isCached(arrived?.id as Id)).toBe(true);
      // The pre-existing rows are still present and ordered after the new one.
      expect(threadList.ids.slice(1)).toEqual(initial.map((m) => m.id));
    });

    it("drops a conversation removed server-side", async () => {
      const mb = await freshMailbox("remove");
      const msgs = await createMessages(mb, [{ subject: "Keep" }, { subject: "Drop" }]);
      await settleConversations(mb, 2);
      await openMailbox(mb);
      const [keep, drop] = msgs;

      await destroyEmails([drop?.id as Id]);
      await settleConversations(mb, 1);
      await syncThreadList();

      expect(threadList.ids).toEqual([keep?.id]);
    });
  });

  describe("syncEmails (Email/changes)", () => {
    it("refreshes a held email whose keywords changed ($seen toggled elsewhere)", async () => {
      const mb = await freshMailbox("seen");
      const [target] = await createMessages(mb, [{ subject: "Unread", seen: false }]);
      await settleConversations(mb, 1);
      await openMailbox(mb);
      const id = target?.id as Id;
      expect(emails[id]?.keywords?.$seen).toBeUndefined();

      await setSeen(id, true);
      await syncEmails();

      expect(emails[id]?.keywords?.$seen).toBe(true);
    });

    it("prunes a destroyed email from the cache and the open list", async () => {
      const mb = await freshMailbox("destroy");
      const msgs = await createMessages(mb, [{ subject: "Alive" }, { subject: "Doomed" }]);
      await settleConversations(mb, 2);
      await openMailbox(mb);
      const [alive, doomed] = msgs;

      await destroyEmails([doomed?.id as Id]);
      await settleConversations(mb, 1);
      await syncEmails();

      expect(isCached(doomed?.id as Id)).toBe(false);
      expect(threadList.ids).toEqual([alive?.id]);
    });
  });

  describe("syncMailboxes (Mailbox/changes)", () => {
    it("upserts a newly-created mailbox, then removes it when destroyed", async () => {
      // Baseline cursor first, so the create below is what the next drain reports.
      await loadMailboxes();

      const created = await createMailbox(`itest-sync-mbchange-${Date.now()}`);
      mailboxesToClean.push(created);
      await syncMailboxes();
      expect(mailboxRow(created)).toBeDefined();

      await destroyMailbox(created);
      // Already destroyed — drop it from the cleanup list so afterEach doesn't re-destroy.
      mailboxesToClean.splice(mailboxesToClean.indexOf(created), 1);
      await syncMailboxes();
      expect(mailboxRow(created)).toBeUndefined();
    });
  });
});
