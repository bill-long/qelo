import process from "node:process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAP_CORE, CAP_MAIL, emailGet, emailQuery, emailSet, methodResult } from "@/jmap/methods";
import type { Email, Id } from "@/jmap/types";
import {
  identities,
  loadIdentities,
  resetCompose,
  saveDraft,
  selectedIdentity,
  send,
  updateDraft,
} from "@/stores/compose";
import { loadMailboxes, mailboxIdByRole } from "@/stores/mailboxes";
import { connectTestClient, disconnectTestClient, resetStores, testClient } from "./harness";

// PR 3 — compose foundation (identities, drafts, send). Drives the real compose store actions
// against a live Stalwart (CLAUDE.md forbids mocking), then reads the server back to prove the
// draft lands in Drafts with $draft, and that a send is the headline one-batch round trip:
// it files the Sent copy ($draft cleared) AND is delivered to the Inbox (exercising the SMTP
// loopback + the path the push drain later surfaces).

const ACCOUNT_EMAIL =
  process.env.QELO_TEST_EMAIL ?? process.env.QELO_SEED_EMAIL ?? "test@example.test";

describe("compose", () => {
  // Every message this suite creates (Drafts/Sent/Inbox copies) carries one of these subjects;
  // afterEach destroys everything matching, account-wide, so reruns stay idempotent.
  const subjectsToClean: string[] = [];

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(() => {
    resetStores();
    resetCompose();
  });
  afterEach(async () => {
    while (subjectsToClean.length > 0) {
      const subject = subjectsToClean.pop();
      if (subject) await destroyBySubject(subject).catch(() => {});
    }
  });

  function freshSubject(label: string): string {
    const subject = `itest-compose-${label}-${Date.now()}`;
    subjectsToClean.push(subject);
    return subject;
  }

  /** Destroy every email matching `subject` (full-text), account-wide — idempotent teardown. */
  async function destroyBySubject(subject: string): Promise<void> {
    const client = testClient();
    const q = await client.request(
      [emailQuery(client.accountId, "q", { filter: { text: subject } })],
      [CAP_CORE, CAP_MAIL],
    );
    const ids = (methodResult(q, "q").ids ?? []) as Id[];
    if (ids.length === 0) return;
    await client.request([emailSet(client.accountId, "d", { destroy: ids })], [CAP_CORE, CAP_MAIL]);
  }

  /**
   * Poll Email/query until `mailboxId` holds at least `expected` messages matching `subject`,
   * returning their ids. Stalwart indexes query/delivery asynchronously (see harness'
   * settleConversations + the SMTP loopback delay), so a freshly-sent message isn't queryable
   * the instant the /set resolves.
   */
  async function waitForSubject(
    mailboxId: Id,
    subject: string,
    expected = 1,
    timeoutMs = 20000,
  ): Promise<Id[]> {
    const client = testClient();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const resp = await client.request(
        [emailQuery(client.accountId, "q", { filter: { inMailbox: mailboxId, text: subject } })],
        [CAP_CORE, CAP_MAIL],
      );
      const ids = (methodResult(resp, "q").ids ?? []) as Id[];
      if (ids.length >= expected) return ids;
      if (Date.now() >= deadline) {
        throw new Error(
          `Mailbox ${mailboxId} never held ${expected} message(s) for "${subject}" (saw ${ids.length})`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Read one email's keywords + mailboxIds straight from the server. */
  async function serverEmail(id: Id): Promise<Email> {
    const client = testClient();
    const resp = await client.request(
      [
        emailGet(client.accountId, "g", {
          ids: [id],
          properties: ["id", "subject", "keywords", "mailboxIds"],
        }),
      ],
      [CAP_CORE, CAP_MAIL],
    );
    const email = ((methodResult(resp, "g").list ?? []) as Email[])[0];
    if (!email) throw new Error(`Email/get returned nothing for ${id}`);
    return email;
  }

  it("Identity/get returns at least one sending identity, defaulting the selection", async () => {
    await loadIdentities();
    expect(identities().length).toBeGreaterThanOrEqual(1);
    // The store defaults the selection to the first identity, with a usable from-address.
    expect(selectedIdentity()?.email).toBeTruthy();
  });

  it("saveDraft lands a message in Drafts with $draft set", async () => {
    await loadMailboxes();
    await loadIdentities();
    const draftsId = mailboxIdByRole("drafts");
    expect(draftsId, "the dev account exposes a Drafts mailbox").toBeDefined();

    const subject = freshSubject("draft");
    updateDraft("to", ACCOUNT_EMAIL);
    updateDraft("subject", subject);
    updateDraft("body", "A saved draft body.");

    expect(await saveDraft()).toBe(true);

    const ids = await waitForSubject(draftsId as Id, subject);
    const email = await serverEmail(ids[0] as Id);
    expect(email.keywords.$draft).toBe(true);
    expect(email.mailboxIds[draftsId as Id]).toBe(true);
  });

  it("send is one batch: files the Sent copy ($draft cleared) and delivers to Inbox", async () => {
    await loadMailboxes();
    await loadIdentities();
    const draftsId = mailboxIdByRole("drafts") as Id;
    const sentId = mailboxIdByRole("sent") as Id;
    const inboxId = mailboxIdByRole("inbox") as Id;
    expect(draftsId, "Drafts mailbox").toBeDefined();
    expect(sentId, "Sent mailbox").toBeDefined();
    expect(inboxId, "Inbox mailbox").toBeDefined();

    const subject = freshSubject("send");
    updateDraft("to", ACCOUNT_EMAIL); // send to our own address so it loops back to the Inbox
    updateDraft("subject", subject);
    updateDraft("body", "A sent message body.");

    // The single batched round trip is exactly two requests' worth of work in one request: assert
    // the action issued just one JMAP request (Email/set{create} + EmailSubmission/set together).
    const before = testClient().requestCount;
    expect(await send()).toBe(true);
    expect(testClient().requestCount - before).toBe(1);

    // Sent copy: onSuccessUpdateEmail cleared $draft, set $seen, and moved it Drafts→Sent.
    const sentIds = await waitForSubject(sentId, subject);
    const sentEmail = await serverEmail(sentIds[0] as Id);
    expect(sentEmail.keywords.$draft).toBeUndefined();
    expect(sentEmail.keywords.$seen).toBe(true);
    expect(sentEmail.mailboxIds[sentId]).toBe(true);
    expect(sentEmail.mailboxIds[draftsId]).toBeUndefined();

    // Delivered copy: the SMTP loopback put a fresh message in the Inbox.
    const inboxIds = await waitForSubject(inboxId, subject);
    const inboxEmail = await serverEmail(inboxIds[0] as Id);
    expect(inboxEmail.mailboxIds[inboxId]).toBe(true);
  });
});
