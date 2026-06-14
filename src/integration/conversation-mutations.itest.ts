import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAP_CORE, CAP_MAIL, emailGet, methodResult } from "@/jmap/methods";
import type { Id } from "@/jmap/types";
import {
  deleteConversationForever,
  emails,
  loadThread,
  markConversationSeen,
  moveConversation,
  openMailbox,
  setConversationFlagged,
  thread,
  threadList,
  trashConversation,
} from "@/stores/emails";
import { loadMailboxes, mailboxIdByRole } from "@/stores/mailboxes";
import { setSelectedMailboxId } from "@/stores/ui";
import {
  connectTestClient,
  createMailbox,
  createThread,
  destroyEmails,
  destroyMailbox,
  disconnectTestClient,
  resetStores,
  settleConversations,
  testClient,
} from "./harness";

// Deferred item 2 — whole-conversation mutations. A collapsed list row / dragged conversation is
// acted on by its REPRESENTATIVE email id; these store actions expand it to the whole thread and
// apply the patch across every message (keywords) or every message in the open folder (mailbox
// ops). Drives the real actions against a live Stalwart, then reads the server back to prove the
// whole conversation — not just the representative — converged (CLAUDE.md forbids mocking).
describe("whole-conversation mutations", () => {
  const mailboxesToClean: Id[] = [];
  const emailsToClean: Id[] = [];

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(resetStores);
  afterEach(async () => {
    // Emails first (a moved/trashed one may live in a role mailbox we must NOT destroy).
    if (emailsToClean.length > 0) {
      await destroyEmails(emailsToClean.splice(0)).catch(() => {});
    }
    while (mailboxesToClean.length > 0) {
      const id = mailboxesToClean.pop();
      if (id) await destroyMailbox(id).catch(() => {});
    }
  });

  async function freshMailbox(label: string): Promise<Id> {
    const id = await createMailbox(`itest-convmut-${label}-${Date.now()}`);
    mailboxesToClean.push(id);
    return id;
  }

  /** Read one property map (keywords / mailboxIds) for an email straight from the server. */
  async function serverEmail(id: Id, property: string): Promise<Record<string, true>> {
    const client = testClient();
    const responses = await client.request(
      [emailGet(client.accountId, "g", { ids: [id], properties: ["id", property] })],
      [CAP_CORE, CAP_MAIL],
    );
    const list = (methodResult(responses, "g").list ?? []) as Array<Record<string, unknown>>;
    return (list[0]?.[property] as Record<string, true>) ?? {};
  }

  /** True once the server no longer holds the email at all (a hard destroy landed). */
  async function serverHasEmail(id: Id): Promise<boolean> {
    const client = testClient();
    const responses = await client.request(
      [emailGet(client.accountId, "g", { ids: [id], properties: ["id"] })],
      [CAP_CORE, CAP_MAIL],
    );
    return ((methodResult(responses, "g").list ?? []) as unknown[]).length > 0;
  }

  /** Move an email between mailboxes server-side (to fan a thread across folders for a test). */
  async function moveServerSide(id: Id, fromId: Id, toId: Id): Promise<void> {
    const client = testClient();
    await client.request(
      [
        [
          "Email/set",
          {
            accountId: client.accountId,
            update: { [id]: { [`mailboxIds/${fromId}`]: null, [`mailboxIds/${toId}`]: true } },
          },
          "mv",
        ],
      ],
      [CAP_CORE, CAP_MAIL],
    );
  }

  describe("markConversationSeen", () => {
    it("marks every message in the conversation read, not just the representative", async () => {
      const src = await freshMailbox("read-src");
      const msgs = await createThread(src, 3); // collapses to one row
      const ids = msgs.map((m) => m.id);

      const [repId] = await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);
      expect(threadList.ids).toEqual([repId]);

      // The conversation isn't open in the reading pane, so this exercises the Thread/get expand.
      await markConversationSeen(repId as Id, true);

      // Every message — including the non-representative ones — is $seen in the store and server.
      for (const id of ids) {
        expect(emails[id]?.keywords.$seen, `store $seen for ${id}`).toBe(true);
        expect((await serverEmail(id, "keywords")).$seen, `server $seen for ${id}`).toBe(true);
      }
    });

    it("expands via the open reading-pane thread without a second fetch (shortcut)", async () => {
      const src = await freshMailbox("read-shortcut");
      const msgs = await createThread(src, 2);
      const ids = msgs.map((m) => m.id);
      const threadId = msgs[0]?.threadId as Id;

      const [repId] = await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);
      await loadThread(threadId); // now thread.emailIds holds the whole conversation
      expect(thread.emailIds).toEqual(expect.arrayContaining(ids));

      // With the thread loaded, the expand is a no-op (no Thread/get): only the Email/set fires.
      const before = testClient().requestCount;
      await markConversationSeen(repId as Id, true);
      expect(testClient().requestCount - before).toBe(1);

      for (const id of ids) {
        expect((await serverEmail(id, "keywords")).$seen, `server $seen for ${id}`).toBe(true);
      }
    });
  });

  describe("setConversationFlagged", () => {
    it("flags every message in the conversation", async () => {
      const src = await freshMailbox("flag-src");
      const msgs = await createThread(src, 3);
      const ids = msgs.map((m) => m.id);

      const [repId] = await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);

      await setConversationFlagged(repId as Id, true);

      for (const id of ids) {
        expect(emails[id]?.keywords.$flagged, `store $flagged for ${id}`).toBe(true);
        expect((await serverEmail(id, "keywords")).$flagged, `server $flagged for ${id}`).toBe(
          true,
        );
      }
    });
  });

  describe("moveConversation", () => {
    it("moves every message of the conversation in the open folder and prunes the row", async () => {
      const src = await freshMailbox("move-src");
      const dst = await freshMailbox("move-dst");
      const msgs = await createThread(src, 3);
      const ids = msgs.map((m) => m.id);

      const [repId] = await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);
      expect(threadList.ids).toEqual([repId]);

      await moveConversation(repId as Id, dst);

      for (const id of ids) {
        const server = await serverEmail(id, "mailboxIds");
        expect(server[src], `server src for ${id}`).toBeUndefined();
        expect(server[dst], `server dst for ${id}`).toBe(true);
      }
      // The collapsed row left the open list.
      expect(threadList.ids).not.toContain(repId);
    });

    it("moves only the open folder's messages, leaving the rest of the thread untouched", async () => {
      const src = await freshMailbox("scope-src");
      const dst = await freshMailbox("scope-dst");
      const other = await freshMailbox("scope-other");
      const msgs = await createThread(src, 2); // [older, newer]; newer is the representative
      const filedAway = msgs[0]?.id as Id; // pre-move this one out of src into `other`
      const stays = msgs[1]?.id as Id;

      // Fan the thread across folders: one message now lives in `other`, the rest in `src`.
      await moveServerSide(filedAway, src, other);

      // src now collapses to one conversation whose representative is the message still in src.
      const [repId] = await settleConversations(src, 1);
      expect(repId).toBe(stays);
      setSelectedMailboxId(src);
      await openMailbox(src);

      await moveConversation(repId as Id, dst);

      // The in-folder message moved to dst…
      const movedServer = await serverEmail(stays, "mailboxIds");
      expect(movedServer[dst]).toBe(true);
      expect(movedServer[src]).toBeUndefined();

      // …but the message already filed in `other` was NOT pulled into dst — it stayed put.
      const filedServer = await serverEmail(filedAway, "mailboxIds");
      expect(filedServer[other]).toBe(true);
      expect(filedServer[dst]).toBeUndefined();
      expect(filedServer[src]).toBeUndefined();
      // The store reflects the same: we never optimistically patched the out-of-folder message.
      expect(emails[filedAway]?.mailboxIds[other]).toBe(true);
      expect(emails[filedAway]?.mailboxIds[dst]).toBeUndefined();
    });
  });

  describe("trashConversation (role-resolved)", () => {
    it("moves the whole conversation in the open folder to the trash-role mailbox", async () => {
      const src = await freshMailbox("trash-src");
      const msgs = await createThread(src, 2);
      const ids = msgs.map((m) => m.id);
      emailsToClean.push(...ids); // they end up in the real Trash; clean directly

      await loadMailboxes();
      const trashId = mailboxIdByRole("trash");
      expect(trashId, "the dev account exposes a trash-role mailbox").toBeDefined();

      const [repId] = await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);

      await trashConversation(repId as Id);

      for (const id of ids) {
        const server = await serverEmail(id, "mailboxIds");
        expect(server[src], `server src for ${id}`).toBeUndefined();
        expect(server[trashId as Id], `server trash for ${id}`).toBe(true);
      }
      expect(threadList.ids).not.toContain(repId);
    });
  });

  describe("deleteConversationForever (hard destroy from Trash)", () => {
    it("destroys every message of the conversation in the open Trash folder", async () => {
      await loadMailboxes();
      const trashId = mailboxIdByRole("trash") as Id;
      expect(trashId, "the dev account exposes a trash-role mailbox").toBeDefined();

      // Seed the conversation directly in Trash so the open folder's role is `trash` (the only
      // place delete-forever is offered). Track ids in case the destroy under test doesn't run.
      const msgs = await createThread(trashId, 3);
      const ids = msgs.map((m) => m.id);
      emailsToClean.push(...ids);

      const [repId] = await settleConversations(trashId, 1);
      setSelectedMailboxId(trashId);
      await openMailbox(trashId);
      expect(threadList.ids).toEqual([repId]);

      await deleteConversationForever(repId as Id);

      // Every message is gone from the cache, the visible list, and the server.
      for (const id of ids) {
        expect(emails[id], `cache for ${id}`).toBeUndefined();
        expect(await serverHasEmail(id), `server still has ${id}`).toBe(false);
      }
      expect(threadList.ids).not.toContain(repId);
    });
  });
});
