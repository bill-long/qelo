import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAP_CORE, CAP_MAIL, emailGet, methodResult } from "@/jmap/methods";
import type { Id } from "@/jmap/types";
import {
  archive,
  deleteForever,
  emails,
  moveEmails,
  openMailbox,
  threadList,
  trash,
} from "@/stores/emails";
import { loadMailboxes, mailboxIdByRole } from "@/stores/mailboxes";
import { setSelectedMailboxId } from "@/stores/ui";
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

// PR 2 — mailbox mutations (move / archive / trash / delete forever). Drives the real
// optimistic mailboxIds-patch + threadList.ids-prune store actions against a live Stalwart,
// then reads the server back to prove store, server, and the visible list all converge
// (CLAUDE.md forbids mocking). The role-resolved actions (archive/trash) and the hard destroy
// reach for the account's standard role mailboxes via loadMailboxes.
describe("mailbox mutations", () => {
  const mailboxesToClean: Id[] = [];
  const emailsToClean: Id[] = [];

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(resetStores);
  afterEach(async () => {
    // Emails first (they may live in role mailboxes we must NOT destroy, e.g. Trash).
    if (emailsToClean.length > 0) {
      await destroyEmails(emailsToClean.splice(0)).catch(() => {});
    }
    while (mailboxesToClean.length > 0) {
      const id = mailboxesToClean.pop();
      if (id) await destroyMailbox(id).catch(() => {});
    }
  });

  async function freshMailbox(label: string): Promise<Id> {
    const id = await createMailbox(`itest-mbmut-${label}-${Date.now()}`);
    mailboxesToClean.push(id);
    return id;
  }

  /** Read an email's mailboxIds straight from the server (Email/get reflects writes at once). */
  async function serverMailboxIds(id: Id): Promise<Record<Id, true>> {
    const client = testClient();
    const responses = await client.request(
      [emailGet(client.accountId, "g", { ids: [id], properties: ["id", "mailboxIds"] })],
      [CAP_CORE, CAP_MAIL],
    );
    const list = (methodResult(responses, "g").list ?? []) as Array<{
      id: Id;
      mailboxIds: Record<Id, true>;
    }>;
    return list[0]?.mailboxIds ?? {};
  }

  /** True once the server no longer holds the email at all (a hard destroy landed). */
  async function serverHasEmail(id: Id): Promise<boolean> {
    const client = testClient();
    const responses = await client.request(
      [emailGet(client.accountId, "g", { ids: [id], properties: ["id"] })],
      [CAP_CORE, CAP_MAIL],
    );
    const list = (methodResult(responses, "g").list ?? []) as Array<{ id: Id }>;
    return list.length > 0;
  }

  describe("moveEmails", () => {
    it("moves a row between two folders and prunes it from the open list", async () => {
      const src = await freshMailbox("move-src");
      const dst = await freshMailbox("move-dst");
      const [msg] = await createMessages(src, [{ subject: "Move me" }]);
      const id = msg?.id as Id;

      await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);
      expect(threadList.ids).toContain(id);

      await moveEmails([id], dst);

      // Store: the open folder is gone from mailboxIds, the target is present.
      expect(emails[id]?.mailboxIds[src]).toBeUndefined();
      expect(emails[id]?.mailboxIds[dst]).toBe(true);
      // Server agrees.
      const server = await serverMailboxIds(id);
      expect(server[src]).toBeUndefined();
      expect(server[dst]).toBe(true);
      // The visible list dropped the moved-away row.
      expect(threadList.ids).not.toContain(id);
    });
  });

  describe("archive (role-resolved)", () => {
    it("moves the open folder's email into the archive-role mailbox", async () => {
      const src = await freshMailbox("archive-src");
      // The dev account's default set has no archive role, so provision one for this test.
      const archiveMb = await createMailbox(`itest-mbmut-archive-${Date.now()}`, "archive");
      mailboxesToClean.push(archiveMb);
      const [msg] = await createMessages(src, [{ subject: "Archive me" }]);
      const id = msg?.id as Id;

      await loadMailboxes();
      const archiveId = mailboxIdByRole("archive");
      expect(archiveId, "the provisioned archive-role mailbox is resolved").toBe(archiveMb);

      await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);

      await archive([id]);

      expect(emails[id]?.mailboxIds[src]).toBeUndefined();
      expect(emails[id]?.mailboxIds[archiveId as Id]).toBe(true);
      const server = await serverMailboxIds(id);
      expect(server[archiveId as Id]).toBe(true);
      expect(threadList.ids).not.toContain(id);
    });
  });

  describe("trash (D2 default delete)", () => {
    it("moves the open folder's email into the trash-role mailbox", async () => {
      const src = await freshMailbox("trash-src");
      const [msg] = await createMessages(src, [{ subject: "Trash me" }]);
      const id = msg?.id as Id;
      emailsToClean.push(id); // ends up in the real Trash; clean it up directly

      await loadMailboxes();
      const trashId = mailboxIdByRole("trash");
      expect(trashId, "the dev account exposes a trash-role mailbox").toBeDefined();

      await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);

      await trash([id]);

      expect(emails[id]?.mailboxIds[src]).toBeUndefined();
      expect(emails[id]?.mailboxIds[trashId as Id]).toBe(true);
      const server = await serverMailboxIds(id);
      expect(server[trashId as Id]).toBe(true);
      expect(threadList.ids).not.toContain(id);
    });
  });

  describe("deleteForever (hard destroy from Trash)", () => {
    it("destroys the email server-side and prunes it from the store + list", async () => {
      await loadMailboxes();
      const trashId = mailboxIdByRole("trash");
      expect(trashId, "the dev account exposes a trash-role mailbox").toBeDefined();

      // Seed the message directly in Trash so the open folder's role is `trash` (the only place
      // deleteForever is offered). Track it in case the destroy under test doesn't run.
      const [msg] = await createMessages(trashId as Id, [{ subject: "Delete me forever" }]);
      const id = msg?.id as Id;
      emailsToClean.push(id);

      await settleConversations(trashId as Id, 1);
      setSelectedMailboxId(trashId as Id);
      await openMailbox(trashId as Id);
      expect(threadList.ids).toContain(id);

      await deleteForever([id]);

      // Gone from the cache, the visible list, and the server.
      expect(emails[id]).toBeUndefined();
      expect(threadList.ids).not.toContain(id);
      expect(await serverHasEmail(id)).toBe(false);
    });
  });

  describe("refused move reconciles + re-inserts the row", () => {
    it("keeps the accepted row moved and restores the refused row to the list", async () => {
      const src = await freshMailbox("refuse-src");
      const dst = await freshMailbox("refuse-dst");
      const [alive, doomed] = await createMessages(src, [
        { subject: "Survives move" },
        { subject: "Refused move" },
      ]);
      const aliveId = alive?.id as Id;
      const doomedId = doomed?.id as Id;

      await settleConversations(src, 2);
      setSelectedMailboxId(src);
      await openMailbox(src);
      expect(threadList.ids).toEqual(expect.arrayContaining([aliveId, doomedId]));

      // Destroy `doomed` server-side but keep it cached (no sync), so the batched Email/set
      // update accepts `alive` and refuses `doomed` (notFound in notUpdated) — the per-item
      // refusal the reconcile + list re-insert must handle.
      await destroyEmails([doomedId]);

      await moveEmails([aliveId, doomedId], dst);

      // Accepted row: moved, and dropped from the list.
      expect(emails[aliveId]?.mailboxIds[dst]).toBe(true);
      expect((await serverMailboxIds(aliveId))[dst]).toBe(true);
      expect(threadList.ids).not.toContain(aliveId);

      // Refused row: reconciled back to its prior folder and re-inserted into the list (it never
      // really left the open folder, so its row belongs there).
      expect(emails[doomedId]?.mailboxIds[src]).toBe(true);
      expect(emails[doomedId]?.mailboxIds[dst]).toBeUndefined();
      expect(threadList.ids).toContain(doomedId);
    });
  });

  describe("deleteForever on an already-gone email", () => {
    it("treats a notFound refusal as gone — the row stays pruned and the cache is cleared", async () => {
      const src = await freshMailbox("del-gone");
      const [msg] = await createMessages(src, [{ subject: "Already gone" }]);
      const id = msg?.id as Id;

      await settleConversations(src, 1);
      setSelectedMailboxId(src);
      await openMailbox(src);
      expect(threadList.ids).toContain(id);

      // Destroy it server-side but keep it cached (no sync), so the destroy under test gets a
      // notFound refusal — which deleteForever must treat as gone, not re-insert as a survivor.
      await destroyEmails([id]);

      await deleteForever([id]);

      expect(emails[id]).toBeUndefined();
      expect(threadList.ids).not.toContain(id);
      expect(await serverHasEmail(id)).toBe(false);
    });
  });
});
