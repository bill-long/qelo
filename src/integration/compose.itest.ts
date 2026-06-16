// @vitest-environment jsdom
//
// This suite (uniquely among the integration tests) drives send()/saveDraft(), whose path now
// sanitizes the composed HTML (DOMPurify) and derives the plain-text alternative (htmlToText) — both
// need a DOM. The rest of the integration config runs in node; this per-file override gives just this
// file a DOM while keeping the real network client (node fetch + the loopback TLS trust) intact.
import { Buffer, Blob as NodeBlob, File as NodeFile } from "node:buffer";
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
import type { Email, Id, Identity } from "@/jmap/types";
import {
  composeError,
  draft,
  identities,
  insertInlineImage,
  loadIdentities,
  pendingDraftId,
  resetCompose,
  saveDraft,
  selectedIdentity,
  send,
  setIdentities,
  setSelectedIdentityId,
  startForward,
  startReply,
  updateDraft,
} from "@/stores/compose";
import { loadMailboxes, mailboxIdByRole } from "@/stores/mailboxes";
import {
  connectTestClient,
  createMessages,
  disconnectTestClient,
  resetStores,
  testClient,
} from "./harness";

// The jsdom env (above) swaps in jsdom's File/Blob, but the real blob upload goes through undici
// fetch, which needs a WHATWG Blob exposing .stream() — jsdom's lacks it. Swap node's File/Blob in
// for the duration of this suite (the send-path DOM work only needs document/window, which jsdom
// still provides), and restore them afterward so the mutation can't leak to other files in the worker.
const jsdomFile = globalThis.File;
const jsdomBlob = globalThis.Blob;
beforeAll(() => {
  globalThis.File = NodeFile as unknown as typeof globalThis.File;
  globalThis.Blob = NodeBlob as unknown as typeof globalThis.Blob;
});
afterAll(() => {
  globalThis.File = jsdomFile;
  globalThis.Blob = jsdomBlob;
});

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

  // A real 1×1 PNG, so the inline-image parts carry genuine image bytes through the blob round trip.
  const PNG_1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC",
    "base64",
  );

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

  /** Read one email with the full reading-pane property set (threadId, headers, body values). */
  async function serverEmailDetail(id: Id): Promise<Email> {
    const client = testClient();
    const resp = await client.request(
      [
        emailGet(client.accountId, "g", {
          ids: [id],
          properties: [...DETAIL_PROPERTIES],
          fetchAllBodyValues: true,
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
    updateDraft("bodyHtml", "<div>A saved draft body.</div>");

    expect(await saveDraft()).toBe(true);

    const ids = await waitForSubject(draftsId as Id, subject);
    const email = await serverEmail(ids[0] as Id);
    expect(email.keywords.$draft).toBe(true);
    expect(email.mailboxIds[draftsId as Id]).toBe(true);
  });

  it("send rejects a mistyped recipient instead of silently dropping it", async () => {
    await loadMailboxes();
    await loadIdentities();

    // A valid recipient AND a mistyped one: parseRecipients would drop "nope" and send only to the
    // valid address. The store must instead refuse, naming the bad token, with no round trip.
    updateDraft("to", "valid@example.test, nope");
    updateDraft("subject", freshSubject("invalid"));
    updateDraft("bodyHtml", "<div>Should not be sent.</div>");

    const before = testClient().requestCount;
    expect(await send()).toBe(false);
    expect(composeError()).toContain("nope");
    expect(testClient().requestCount).toBe(before); // refused before any send
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
    updateDraft("bodyHtml", "<div>A sent <b>message</b> body.</div>");

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

    // The body went out as multipart/alternative: the server parsed both a text/html part (carrying
    // the composed markup) and a text/plain alternative (the derived fallback).
    const sentDetail = await serverEmailDetail(sentIds[0] as Id);
    const htmlPart = sentDetail.htmlBody?.[0];
    const textPart = sentDetail.textBody?.[0];
    expect(htmlPart?.type).toBe("text/html");
    expect(textPart?.type).toBe("text/plain");
    const htmlValue = htmlPart?.partId
      ? sentDetail.bodyValues?.[htmlPart.partId]?.value
      : undefined;
    const textValue = textPart?.partId
      ? sentDetail.bodyValues?.[textPart.partId]?.value
      : undefined;
    expect(htmlValue).toContain("<b>message</b>");
    expect(textValue).toContain("A sent message body."); // tags flattened to plain text

    // Delivered copy: the SMTP loopback put a fresh message in the Inbox.
    const inboxIds = await waitForSubject(inboxId, subject);
    const inboxEmail = await serverEmail(inboxIds[0] as Id);
    expect(inboxEmail.mailboxIds[inboxId]).toBe(true);
  });

  it("a refused submission leaves ONE recoverable draft; a retry cleans it up (no duplicate)", async () => {
    await loadMailboxes();
    await loadIdentities();
    const draftsId = mailboxIdByRole("drafts") as Id;
    const sentId = mailboxIdByRole("sent") as Id;
    expect(draftsId, "Drafts mailbox").toBeDefined();
    expect(sentId, "Sent mailbox").toBeDefined();

    const subject = freshSubject("refuse");
    updateDraft("to", ACCOUNT_EMAIL);
    updateDraft("subject", subject);
    updateDraft("bodyHtml", "<div>This first send will be refused.</div>");

    // Force a genuine server-side EmailSubmission/set refusal without mocking: keep the real
    // identity's from-address (so the Email/set create still SUCCEEDS and the draft really lands in
    // Drafts) but point the submission at a non-existent identityId, which Stalwart refuses
    // (notCreated). That reproduces exactly the orphaned-draft scenario this fix targets.
    const real = selectedIdentity();
    expect(real, "a real sending identity").toBeDefined();
    setIdentities([{ ...(real as Identity), id: "qelo-nonexistent-identity" }]);
    setSelectedIdentityId(null); // selectedIdentity() then falls back to list[0] = the bogus one

    const before = testClient().requestCount;
    expect(await send()).toBe(false);
    expect(testClient().requestCount - before).toBe(1); // one batched round trip, then refused
    expect(composeError()).toContain("saved to Drafts");

    // The just-created draft sits in Drafts with $draft, and the store remembers its id to clean up.
    const orphanId = pendingDraftId();
    expect(orphanId, "the refused draft's id is tracked").toBeTruthy();
    const orphan = await serverEmail(orphanId as Id);
    expect(orphan.keywords.$draft).toBe(true);
    expect(orphan.mailboxIds[draftsId]).toBe(true);

    // Retry with the real identity restored. The retry destroys the orphan in the SAME Email/set
    // that recreates the draft (Email content is immutable, so it can't be updated in place), then
    // submits — so no second draft accumulates.
    setIdentities([real as Identity]);
    setSelectedIdentityId((real as Identity).id);
    expect(await send()).toBe(true);
    expect(pendingDraftId(), "tracking cleared after a successful send").toBeNull();

    // The orphan is GONE from the server — the retry destroyed it rather than leaving a duplicate.
    // (Email/get by id is immediately consistent, so this is deterministic.)
    await expect(serverEmail(orphanId as Id)).rejects.toThrow();

    // And exactly one copy made it to Sent: a fresh draft (a NEW id, not the destroyed orphan),
    // filed Drafts→Sent by onSuccessUpdateEmail.
    const sentIds = await waitForSubject(sentId, subject, 1);
    expect(sentIds).toHaveLength(1);
    expect(sentIds).not.toContain(orphanId);
    const sent = await serverEmail(sentIds[0] as Id);
    expect(sent.keywords.$draft).toBeUndefined();
    expect(sent.mailboxIds[sentId]).toBe(true);
    expect(sent.mailboxIds[draftsId]).toBeUndefined();
  });

  it("startReply → send carries inReplyTo/references and stays in the source's thread", async () => {
    await loadMailboxes();
    await loadIdentities();
    const inboxId = mailboxIdByRole("inbox") as Id;
    const sentId = mailboxIdByRole("sent") as Id;
    expect(inboxId, "Inbox mailbox").toBeDefined();
    expect(sentId, "Sent mailbox").toBeDefined();

    // Seed a source message FROM our own address, so the reply (To = its From) loops straight
    // back to us and the whole exchange threads under one account.
    const subject = freshSubject("reply");
    const [src] = await createMessages(inboxId, [
      { subject, from: { name: "Test User", email: ACCOUNT_EMAIL }, text: "Original body." },
    ]);
    const source = await serverEmailDetail((src as { id: Id }).id);

    // Prefill the reply off the real (server-read) source, then send it as the one batch.
    startReply(source);
    expect(await send()).toBe(true);

    // The Sent copy is the only "Re: <subject>" in Sent (the source lives in Inbox).
    const sentIds = await waitForSubject(sentId, subject);
    const reply = await serverEmailDetail(sentIds[0] as Id);
    expect(reply.subject).toBe(`Re: ${subject}`);
    // Threading headers: inReplyTo = the source's Message-ID; references ends with it.
    expect(reply.inReplyTo).toEqual(source.messageId);
    expect(reply.references?.[reply.references.length - 1]).toBe(source.messageId?.[0]);
    // And the payoff: the reply lands in the SAME thread as the source.
    expect(reply.threadId).toBe(source.threadId);
  });

  it("startForward re-attaches the source's parts by blobId (a copy, not a re-upload), and send carries them", async () => {
    await loadMailboxes();
    await loadIdentities();
    const inboxId = mailboxIdByRole("inbox") as Id;
    const sentId = mailboxIdByRole("sent") as Id;
    expect(inboxId, "Inbox mailbox").toBeDefined();
    expect(sentId, "Sent mailbox").toBeDefined();

    // Seed a source message that actually carries an attachment: upload the bytes through the real
    // blob transport, then create an Inbox message referencing that blobId as an attachment part.
    const content = "Forward me — these bytes must survive the blob reference.\n";
    const byteSize = Buffer.byteLength(content, "utf8");
    const upload = await testClient().upload(
      new File([content], "doc.txt", { type: "text/plain" }),
      "text/plain",
    );
    const subject = freshSubject("forward");
    const client = testClient();
    const createResp = await client.request(
      [
        emailSet(client.accountId, "src-set", {
          create: {
            src: {
              mailboxIds: { [inboxId]: true },
              from: [{ name: "Test User", email: ACCOUNT_EMAIL }],
              to: [{ name: "Test User", email: ACCOUNT_EMAIL }],
              subject,
              bodyValues: { b: { value: "Original with an attachment.", isTruncated: false } },
              textBody: [{ partId: "b", type: "text/plain" }],
              attachments: [
                {
                  blobId: upload.blobId,
                  type: "text/plain",
                  name: "doc.txt",
                  disposition: "attachment",
                  size: upload.size,
                },
              ],
            },
          },
        }),
      ],
      [CAP_CORE, CAP_MAIL],
    );
    const created = (methodResult(createResp, "src-set").created ?? {}) as Record<
      string,
      { id: Id }
    >;
    const srcId = created.src?.id as Id;
    expect(srcId, "the source message was created").toBeDefined();

    // Read it back the way the reading pane would (with attachments), then forward it. Note the
    // stored part's blobId is NOT the upload blobId: Stalwart re-keys the blob once it's embedded in
    // a message, so a forward must reference the part's stored blobId (what the reading pane holds),
    // which is exactly what forwardAttachments carries — never the transient upload id.
    const source = await serverEmailDetail(srcId);
    const sourcePart = (source.attachments ?? [])[0];
    expect(sourcePart, "the source message carries one attachment part").toBeDefined();
    startForward(source);

    // The composer prefilled the source's attachment by referencing its existing (stored) blobId —
    // no re-upload (the chip carries the SAME server blobId the source part held).
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0]?.blobId).toBe(sourcePart?.blobId);
    expect(draft.attachments[0]?.name).toBe("doc.txt");
    expect(draft.attachments[0]?.size).toBe(byteSize);

    // Forward to ourselves so the sent copy is reachable; send is the one batch.
    updateDraft("to", ACCOUNT_EMAIL);
    expect(await send()).toBe(true);

    // The Sent "Fwd: …" copy carries the attachment part, and its bytes round-trip unchanged —
    // proving the server resolved the referenced blob into the new message without a re-upload.
    const sentIds = await waitForSubject(sentId, subject);
    const sent = await serverEmailDetail(sentIds[0] as Id);
    expect(sent.subject).toBe(`Fwd: ${subject}`);
    const part = (sent.attachments ?? [])[0];
    expect(part, "the forwarded message carries one attachment part").toBeDefined();
    expect(part?.name).toBe("doc.txt");
    expect(part?.size).toBe(byteSize);
    const blob = await testClient().download(part?.blobId as Id, part?.type as string, "doc.txt");
    expect(await blob.text()).toBe(content);
  });

  it("insertInlineImage → send emits the image as a disposition:inline part referenced by cid", async () => {
    await loadMailboxes();
    await loadIdentities();
    const sentId = mailboxIdByRole("sent") as Id;
    expect(sentId, "Sent mailbox").toBeDefined();

    const subject = freshSubject("inline");
    updateDraft("to", ACCOUNT_EMAIL); // to ourselves so the Sent copy is reachable
    updateDraft("subject", subject);

    // Upload through the real store action; it returns the cid: URL the editor would embed.
    const cidUrl = await insertInlineImage(new File([PNG_1x1], "pic.png", { type: "image/png" }));
    expect(cidUrl).toMatch(/^cid:.+@qelo\.invalid$/);
    expect(draft.inlineImages).toHaveLength(1);
    updateDraft("bodyHtml", `<div>look:</div><img src="${cidUrl}">`);

    expect(await send()).toBe(true);

    const sentIds = await waitForSubject(sentId, subject);
    const sent = await serverEmailDetail(sentIds[0] as Id);
    // The image rode as an attachments part tagged disposition:inline with a cid (multipart/related),
    // not a plain attachment — and its bytes round-trip through the blob store unchanged.
    const inlinePart = (sent.attachments ?? []).find((p) => p.disposition === "inline");
    expect(inlinePart, "the sent message carries an inline image part").toBeDefined();
    expect(inlinePart?.type).toBe("image/png");
    expect(inlinePart?.cid).toBeTruthy();
    const blob = await testClient().download(
      inlinePart?.blobId as Id,
      inlinePart?.type as string,
      "pic.png",
    );
    expect(Buffer.from(await blob.arrayBuffer()).equals(PNG_1x1)).toBe(true);
    // The HTML body still references the image by cid (so the recipient renders it in place).
    const htmlPart = sent.htmlBody?.[0];
    const htmlValue = htmlPart?.partId ? sent.bodyValues?.[htmlPart.partId]?.value : undefined;
    expect(htmlValue).toContain("<img");
    expect(htmlValue).toContain(`cid:${inlinePart?.cid}`);
  });

  it("startForward keeps the source's inline image inline (cid) while a real attachment becomes a chip", async () => {
    await loadMailboxes();
    await loadIdentities();
    const inboxId = mailboxIdByRole("inbox") as Id;
    const sentId = mailboxIdByRole("sent") as Id;
    expect(inboxId, "Inbox mailbox").toBeDefined();
    expect(sentId, "Sent mailbox").toBeDefined();

    // Seed a source that embeds one inline image (cid'd) AND carries one ordinary attachment.
    const imgUpload = await testClient().upload(
      new File([PNG_1x1], "sig.png", { type: "image/png" }),
      "image/png",
    );
    const docContent = "a real attachment, not inline\n";
    const docUpload = await testClient().upload(
      new File([docContent], "doc.txt", { type: "text/plain" }),
      "text/plain",
    );
    const subject = freshSubject("fwd-inline");
    const cid = "src-inline@qelo.invalid";
    const client = testClient();
    const createResp = await client.request(
      [
        emailSet(client.accountId, "src-set", {
          create: {
            src: {
              mailboxIds: { [inboxId]: true },
              from: [{ name: "Test User", email: ACCOUNT_EMAIL }],
              to: [{ name: "Test User", email: ACCOUNT_EMAIL }],
              subject,
              bodyValues: {
                h: { value: `<div>body</div><img src="cid:${cid}">`, isTruncated: false },
              },
              htmlBody: [{ partId: "h", type: "text/html" }],
              attachments: [
                {
                  blobId: imgUpload.blobId,
                  type: "image/png",
                  name: "sig.png",
                  disposition: "inline",
                  cid,
                  size: imgUpload.size,
                },
                {
                  blobId: docUpload.blobId,
                  type: "text/plain",
                  name: "doc.txt",
                  disposition: "attachment",
                  size: docUpload.size,
                },
              ],
            },
          },
        }),
      ],
      [CAP_CORE, CAP_MAIL],
    );
    const created = (methodResult(createResp, "src-set").created ?? {}) as Record<
      string,
      { id: Id }
    >;
    const srcId = created.src?.id as Id;
    expect(srcId, "the source message was created").toBeDefined();

    // Read it back as the reading pane would (with body values + attachments), then forward it.
    const source = await serverEmailDetail(srcId);
    startForward(source);

    // The split: the inline image is re-referenced inline (not a chip); the real attachment IS a chip.
    expect(draft.inlineImages).toHaveLength(1);
    expect(draft.inlineImages[0]?.type).toBe("image/png");
    expect(draft.attachments).toHaveLength(1);
    expect(draft.attachments[0]?.name).toBe("doc.txt");

    updateDraft("to", ACCOUNT_EMAIL);
    expect(await send()).toBe(true);

    // The Sent "Fwd: …" copy carries BOTH: an inline image part and a separate attachment part.
    const sentIds = await waitForSubject(sentId, subject);
    const sent = await serverEmailDetail(sentIds[0] as Id);
    expect(sent.subject).toBe(`Fwd: ${subject}`);
    const inlinePart = (sent.attachments ?? []).find((p) => p.disposition === "inline");
    const filePart = (sent.attachments ?? []).find((p) => p.disposition !== "inline");
    expect(inlinePart?.type).toBe("image/png");
    expect(filePart?.name).toBe("doc.txt");
    const imgBlob = await testClient().download(inlinePart?.blobId as Id, "image/png", "sig.png");
    expect(Buffer.from(await imgBlob.arrayBuffer()).equals(PNG_1x1)).toBe(true);
  });
});
