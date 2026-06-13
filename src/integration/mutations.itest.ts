import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAP_CORE, CAP_MAIL, emailGet, methodResult } from "@/jmap/methods";
import type { Id } from "@/jmap/types";
import { emails, loadThread, markSeen, openMailbox, setFlagged, thread } from "@/stores/emails";
import { loadMailboxes, mailboxes } from "@/stores/mailboxes";
import { setSelectedMailboxId, setSelectedThreadId } from "@/stores/ui";
import {
  connectTestClient,
  createMailbox,
  createMessages,
  createThread,
  destroyEmails,
  destroyMailbox,
  disconnectTestClient,
  resetStores,
  testClient,
} from "./harness";

// PR 1 — keyword mutations (mark read/unread, flag/unflag, auto-mark-read on open). Drives the
// real optimistic-update → Email/set → rollback store actions against a live Stalwart, then
// reads the server back to prove store and server converge (CLAUDE.md forbids mocking).
describe("keyword mutations", () => {
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
    const id = await createMailbox(`itest-mut-${label}-${Date.now()}`);
    mailboxesToClean.push(id);
    return id;
  }

  /** Read an email's keywords straight from the server (Email/get reflects writes at once). */
  async function serverKeywords(id: Id): Promise<Record<string, true>> {
    const client = testClient();
    const responses = await client.request(
      [emailGet(client.accountId, "g", { ids: [id], properties: ["id", "keywords"] })],
      [CAP_CORE, CAP_MAIL],
    );
    const list = (methodResult(responses, "g").list ?? []) as Array<{
      id: Id;
      keywords: Record<string, true>;
    }>;
    return list[0]?.keywords ?? {};
  }

  describe("markSeen", () => {
    it("toggles $seen on the store and the server", async () => {
      const mb = await freshMailbox("seen");
      const [msg] = await createMessages(mb, [{ subject: "Unread", seen: false }]);
      const id = msg?.id as Id;
      await openMailbox(mb); // cache the row so the optimistic patch has something to touch
      expect(emails[id]?.keywords.$seen).toBeUndefined();

      await markSeen([id], true);
      expect(emails[id]?.keywords.$seen).toBe(true);
      expect((await serverKeywords(id)).$seen).toBe(true);

      await markSeen([id], false);
      expect(emails[id]?.keywords.$seen).toBeUndefined();
      expect((await serverKeywords(id)).$seen).toBeUndefined();
    });
  });

  describe("setFlagged", () => {
    it("toggles $flagged on the store and the server", async () => {
      const mb = await freshMailbox("flag");
      const [msg] = await createMessages(mb, [{ subject: "Plain" }]);
      const id = msg?.id as Id;
      await openMailbox(mb);
      expect(emails[id]?.keywords.$flagged).toBeUndefined();

      await setFlagged([id], true);
      expect(emails[id]?.keywords.$flagged).toBe(true);
      expect((await serverKeywords(id)).$flagged).toBe(true);

      await setFlagged([id], false);
      expect(emails[id]?.keywords.$flagged).toBeUndefined();
      expect((await serverKeywords(id)).$flagged).toBeUndefined();
    });
  });

  describe("auto-mark-read on open (D1)", () => {
    it("marks a thread's shown-and-unread messages $seen when it opens", async () => {
      const mb = await freshMailbox("automark");
      const msgs = await createThread(mb, 2); // one collapsed conversation, both unread
      // Populate the mailboxes store (for the maySetSeen gate) and select the open folder.
      await loadMailboxes();
      expect(mailboxes[mb]?.myRights.maySetSeen, "owner can set $seen").toBe(true);
      setSelectedMailboxId(mb);
      await openMailbox(mb); // caches the rows; the open folder is the gate target

      const threadId = msgs[0]?.threadId as Id;
      setSelectedThreadId(threadId);
      await loadThread(threadId);

      // Every rendered message flips to $seen, on both the store and the server.
      expect(thread.emailIds.length).toBe(2);
      for (const m of msgs) {
        expect(emails[m.id]?.keywords.$seen).toBe(true);
        expect((await serverKeywords(m.id)).$seen).toBe(true);
      }
    });

    it("does not auto-mark when the open folder forbids it (no selection / rights)", async () => {
      const mb = await freshMailbox("noauto");
      const msgs = await createThread(mb, 1);
      // Deliberately leave the mailboxes store empty and the selection unset, so
      // selectedMailboxRights() is undefined → the gate blocks auto-mark.
      await openMailbox(mb);
      const threadId = msgs[0]?.threadId as Id;
      await loadThread(threadId);

      const id = msgs[0]?.id as Id;
      expect(emails[id]?.keywords.$seen).toBeUndefined();
      expect((await serverKeywords(id)).$seen).toBeUndefined();
    });
  });

  describe("rollback on a refused update", () => {
    it("reverts only the row the server refuses, keeping the one it accepts", async () => {
      const mb = await freshMailbox("rollback");
      const [alive, doomed] = await createMessages(mb, [
        { subject: "Survives", seen: false },
        { subject: "Refused", seen: false },
      ]);
      const aliveId = alive?.id as Id;
      const doomedId = doomed?.id as Id;
      await openMailbox(mb); // cache both rows

      // Destroy `doomed` server-side but keep it in our local cache (no sync), so the batched
      // Email/set update gets one accepted row (alive) and one refused row (doomed → notFound
      // in notUpdated) — exactly the per-item failure the rollback path must handle.
      await destroyEmails([doomedId]);

      await markSeen([aliveId, doomedId], true);

      // Accepted row: optimistic value stands and the server reflects it.
      expect(emails[aliveId]?.keywords.$seen).toBe(true);
      expect((await serverKeywords(aliveId)).$seen).toBe(true);
      // Refused row: the optimistic $seen is rolled back to its prior (unread) value.
      expect(emails[doomedId]?.keywords.$seen).toBeUndefined();
    });
  });
});
