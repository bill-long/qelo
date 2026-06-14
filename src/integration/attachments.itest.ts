import { Buffer } from "node:buffer";
import process from "node:process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CAP_CORE,
  CAP_MAIL,
  DETAIL_PROPERTIES,
  emailGet,
  emailQuery,
  emailSet,
  methodResult,
} from "@/jmap/methods";
import type { Email, Id } from "@/jmap/types";
import {
  attachFiles,
  draft,
  loadIdentities,
  resetCompose,
  saveDraft,
  updateDraft,
} from "@/stores/compose";
import { loadMailboxes, mailboxIdByRole } from "@/stores/mailboxes";
import { connectTestClient, disconnectTestClient, resetStores, testClient } from "./harness";

// PR 5 — attachments. Drives the real compose store + blob transport against a live Stalwart
// (CLAUDE.md forbids mocking): upload a small file via client.upload (through attachFiles), attach
// it, save the draft, read the server email back, and assert it carries the attachment part. Then
// download the blob through client.download and assert the bytes round-trip unchanged.

const ACCOUNT_EMAIL =
  process.env.QELO_TEST_EMAIL ?? process.env.QELO_SEED_EMAIL ?? "test@example.test";

describe("attachments", () => {
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
    const subject = `itest-attach-${label}-${Date.now()}`;
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

  /** Poll Email/query until `mailboxId` holds ≥1 message matching `subject`, returning their ids. */
  async function waitForSubject(mailboxId: Id, subject: string, timeoutMs = 20000): Promise<Id[]> {
    const client = testClient();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const resp = await client.request(
        [emailQuery(client.accountId, "q", { filter: { inMailbox: mailboxId, text: subject } })],
        [CAP_CORE, CAP_MAIL],
      );
      const ids = (methodResult(resp, "q").ids ?? []) as Id[];
      if (ids.length >= 1) return ids;
      if (Date.now() >= deadline) {
        throw new Error(`Mailbox ${mailboxId} never held a message for "${subject}"`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Read one email with the full reading-pane property set (incl. attachments). */
  async function serverEmailDetail(id: Id): Promise<Email> {
    const client = testClient();
    const resp = await client.request(
      [emailGet(client.accountId, "g", { ids: [id], properties: [...DETAIL_PROPERTIES] })],
      [CAP_CORE, CAP_MAIL],
    );
    const email = ((methodResult(resp, "g").list ?? []) as Email[])[0];
    if (!email) throw new Error(`Email/get returned nothing for ${id}`);
    return email;
  }

  it("upload → attach → saveDraft carries the attachment, and download round-trips the bytes", async () => {
    await loadMailboxes();
    await loadIdentities();
    const draftsId = mailboxIdByRole("drafts") as Id;
    expect(draftsId, "the dev account exposes a Drafts mailbox").toBeDefined();

    // Upload a small text blob through the real store path (attachFiles → client.upload).
    const content = "Hello from a Qelo attachment integration test.\n";
    const byteSize = Buffer.byteLength(content, "utf8");
    const file = new File([content], "note.txt", { type: "text/plain" });
    await attachFiles([file]);

    // The store appended the uploaded part with the server-recorded blobId + size.
    expect(draft.attachments).toHaveLength(1);
    const attached = draft.attachments[0];
    expect(attached?.blobId).toBeTruthy();
    expect(attached?.name).toBe("note.txt");
    expect(attached?.size).toBe(byteSize);

    // Re-attaching identical bytes dedupes to the same server blobId, so it stays one chip (else
    // removeAttachment(blobId) would later drop both). Confirm against the real content-addressed store.
    await attachFiles([new File([content], "note.txt", { type: "text/plain" })]);
    expect(draft.attachments).toHaveLength(1);

    const subject = freshSubject("draft");
    updateDraft("to", ACCOUNT_EMAIL);
    updateDraft("subject", subject);
    updateDraft("body", "A draft with an attachment.");
    expect(await saveDraft()).toBe(true);

    // Read the saved draft back: it must report hasAttachment and carry the attachment part.
    const ids = await waitForSubject(draftsId, subject);
    const email = await serverEmailDetail(ids[0] as Id);
    expect(email.hasAttachment).toBe(true);
    const part = (email.attachments ?? [])[0];
    expect(part, "the saved email carries one attachment part").toBeDefined();
    expect(part?.name).toBe("note.txt");
    expect(part?.type).toBe("text/plain");
    expect(part?.size).toBe(byteSize);
    expect(part?.blobId).toBeTruthy();

    // Download the blob back through the authenticated transport and assert the bytes round-trip.
    const blob = await testClient().download(
      part?.blobId as Id,
      part?.type as string,
      part?.name as string,
    );
    expect(await blob.text()).toBe(content);
  });
});
