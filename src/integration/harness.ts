// Shared harness for the Stalwart integration suite.
//
// CLAUDE.md forbids mocking the JMAP server, so these tests drive the real store actions
// against a live Stalwart container over HTTP Basic auth (the same scheme dev/stalwart/
// seed.mjs uses — no Rust/OAuth backend under the test runner). This module owns:
//   - connecting a real JmapClient and adopting it into the account store singleton,
//   - server-side fixtures (create/destroy mailboxes + emails) built from raw method calls,
//   - resetting the store singletons + sync cursors between tests for determinism.
//
// This is test-support code talking to a real server, not app code, so it issues a few
// JMAP method calls directly rather than going through the typed store actions it verifies.

import process from "node:process";
import { reconcile } from "solid-js/store";
import { basicAuth } from "@/jmap/auth";
import { JmapClient } from "@/jmap/client";
import { CAP_CORE, CAP_MAIL, methodResult } from "@/jmap/methods";
import type { Id, MethodCall } from "@/jmap/types";
import { adoptClient } from "@/stores/account";
import { emails, setEmails, setPageSize, setThread, setThreadList } from "@/stores/emails";
import { mailboxes, setMailboxes } from "@/stores/mailboxes";
import { setSelectedEmailId, setSelectedMailboxId, setSelectedThreadId } from "@/stores/ui";

export const JMAP_BASE = (process.env.QELO_JMAP_BASE ?? "https://localhost").replace(/\/$/, "");
const EMAIL = process.env.QELO_TEST_EMAIL ?? process.env.QELO_SEED_EMAIL ?? "test@example.test";
// No default password: the test account's password isn't committed (Stalwart's strength
// policy rejects a fixed weak one), so the runner must supply it — same as the seed script.
const PASS = process.env.QELO_TEST_PASS ?? process.env.QELO_SEED_PASS ?? "";

/**
 * JmapClient that counts the requests it issues and can run a one-shot hook the instant
 * before its next request goes out. The counter lets a test assert a store action is a
 * single batched round trip; the hook lets a test deterministically reproduce a concurrent
 * store mutation landing *across* an action's `await` (the stale-snapshot race the anchor
 * windowing guards defend against) without depending on real network timing.
 */
export class InstrumentedClient extends JmapClient {
  requestCount = 0;
  #beforeNext: (() => void) | null = null;

  /** Run `fn` synchronously just before the next `request()` fires, then forget it. */
  runBeforeNextRequest(fn: () => void): void {
    this.#beforeNext = fn;
  }

  override async request(methodCalls: MethodCall[], using?: string[]) {
    const hook = this.#beforeNext;
    this.#beforeNext = null;
    hook?.();
    this.requestCount += 1;
    return super.request(methodCalls, using);
  }
}

let client: InstrumentedClient | null = null;

/** The connected instrumented client (for raw fixture calls / request-count assertions). */
export function testClient(): InstrumentedClient {
  if (!client) throw new Error("connectTestClient() has not run");
  return client;
}

/**
 * Connect a real client to the dev server and adopt it into the account store so the store
 * actions under test issue requests through it. Call once in a `beforeAll`.
 */
export async function connectTestClient(): Promise<InstrumentedClient> {
  if (!PASS) {
    throw new Error(
      "Set QELO_TEST_PASS (or QELO_SEED_PASS) to the dev account password — see " +
        "src/integration/README.md. The integration suite needs a live Stalwart container.",
    );
  }
  const c = new InstrumentedClient(`${JMAP_BASE}/.well-known/jmap`, basicAuth(EMAIL, PASS));
  await c.connect();
  client = c;
  adoptClient(c);
  return c;
}

/** Drop the adopted client. Call in `afterAll`. */
export function disconnectTestClient(): void {
  adoptClient(null);
  client = null;
}

/**
 * Reset every store singleton + sync-affecting bit of module state so each test starts
 * from a clean slate (the singletons persist across tests in one worker). Sync cursors
 * (emailState/mailboxState) are private and monotonic; tests re-baseline them by calling
 * openMailbox/loadMailboxes, so they need no explicit reset here.
 */
export function resetStores(): void {
  setThreadList({
    mailboxId: null,
    ids: [],
    queryState: "",
    loading: false,
    reachedEnd: false,
    error: null,
    loadMoreError: null,
  });
  setThread({ threadId: null, emailIds: [], loading: false, error: null });
  setEmails(reconcile({}));
  setMailboxes(reconcile({}));
  setSelectedMailboxId(null);
  setSelectedThreadId(null);
  setSelectedEmailId(null);
  setPageSize(50);
}

// --- Server-side fixtures --------------------------------------------------

function accountId(): Id {
  return testClient().accountId;
}

/** Issue a single method call and return its (non-error) result args. */
async function callOne(method: MethodCall): Promise<Record<string, unknown>> {
  const responses = await testClient().request([method], [CAP_CORE, CAP_MAIL]);
  return methodResult(responses, method[2]);
}

/** A short random suffix so concurrently-developed runs never collide on a fixture name. */
function suffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stalwart indexes the Email/query sort+collapse asynchronously, so a query issued the
 * instant after an Email/set (or destroy) can omit or misorder just-written rows — even
 * though Email/get and the change log already reflect them. Poll the collapsed query until
 * it reports exactly `expected` conversations, then return them in canonical (newest-first)
 * order — the order openMailbox will see — so order-dependent assertions are deterministic.
 * Seed/mutate, settle, THEN drive the store action under test.
 */
export async function settleConversations(
  mailboxId: Id,
  expected: number,
  timeoutMs = 10000,
): Promise<Id[]> {
  const acc = accountId();
  const deadline = Date.now() + timeoutMs;
  let seen = -1;
  // Require the result to be stable across two consecutive polls: count alone can be
  // reached while the sort is still converging, so the order isn't trustworthy until it
  // stops moving.
  let prevKey: string | null = null;
  for (;;) {
    const q = await callOne([
      "Email/query",
      {
        accountId: acc,
        filter: { inMailbox: mailboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        collapseThreads: true,
      },
      "settle",
    ]);
    const ids = (q.ids ?? []) as Id[];
    seen = ids.length;
    if (seen === expected) {
      const key = ids.join(",");
      if (key === prevKey) return ids;
      prevKey = key;
    } else {
      prevKey = null;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Mailbox ${mailboxId} did not settle to ${expected} conversations (last saw ${seen})`,
      );
    }
    await sleep(150);
  }
}

/** Create an empty top-level mailbox and return its server id. */
export async function createMailbox(name: string): Promise<Id> {
  const set = await callOne([
    "Mailbox/set",
    { accountId: accountId(), create: { mb: { name, parentId: null } } },
    "mbs",
  ]);
  const created = (set.created ?? {}) as Record<string, { id: Id }>;
  const id = created.mb?.id;
  if (!id) throw new Error(`Mailbox/set did not create a mailbox: ${JSON.stringify(set)}`);
  return id;
}

/** Destroy a mailbox and every email it contains (idempotent teardown). */
export async function destroyMailbox(id: Id): Promise<void> {
  await callOne([
    "Mailbox/set",
    { accountId: accountId(), destroy: [id], onDestroyRemoveEmails: true },
    "mbd",
  ]);
}

export interface MessageSpec {
  subject: string;
  from?: { name: string; email: string };
  seen?: boolean;
  /** ISO receivedAt; defaults are assigned descending so spec order is newest-first. */
  receivedAt?: string;
  text?: string;
  html?: string;
  /** Message-ID of the message this one replies to (for threading). */
  inReplyTo?: string;
  /** Reference chain for threading (ancestor Message-IDs). */
  references?: string[];
  /** Explicit Message-ID; one is generated if omitted. */
  messageId?: string;
}

export interface CreatedMessage {
  id: Id;
  threadId: Id;
  messageId: string;
}

function isoNoMillis(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

// Deterministic receivedAt allocator. Two messages created in the same wall-clock second
// would tie on receivedAt and Stalwart breaks the tie by internal id (not creation order),
// so "newest" becomes ambiguous. Instead hand out timestamps from a fixed future anchor
// (well clear of the 2026 seed data), reserving a fresh block of strictly-greater,
// hour-separated slots per batch. A later batch is therefore wholly newer than an earlier
// one, and slots within a batch are distinct — making every query order unambiguous.
const HOUR_MS = 3600_000;
let batchClock = Date.parse("2030-01-01T00:00:00Z");
function reserveBatch(count: number): number {
  batchClock += (count + 1) * HOUR_MS;
  return batchClock;
}

/**
 * Create the given messages in one mailbox (one batched Email/set), then read back their
 * server id + threadId. Messages are independent threads unless wired together via
 * inReplyTo/references. Returned in spec order.
 */
export async function createMessages(
  mailboxId: Id,
  specs: MessageSpec[],
): Promise<CreatedMessage[]> {
  const acc = accountId();
  // spec[0] newest → spec[n-1] oldest, all in this batch's reserved (newer) slot block.
  const base = reserveBatch(specs.length);
  const creations: Record<string, Record<string, unknown>> = {};
  const messageIds: string[] = [];
  specs.forEach((spec, i) => {
    const messageId = spec.messageId ?? `qelo-itest-${suffix()}-${i}@example.test`;
    messageIds.push(messageId);
    const receivedAt = spec.receivedAt ?? isoNoMillis(base - i * HOUR_MS);
    creations[`m${i}`] = {
      mailboxIds: { [mailboxId]: true },
      keywords: spec.seen ? { $seen: true } : {},
      from: [spec.from ?? { name: "Sender", email: "sender@example.test" }],
      to: [{ name: "Test User", email: EMAIL }],
      subject: spec.subject,
      receivedAt,
      messageId: [messageId],
      ...(spec.inReplyTo ? { inReplyTo: [spec.inReplyTo] } : {}),
      ...(spec.references ? { references: spec.references } : {}),
      bodyValues: {
        t: { value: spec.text ?? `${spec.subject} body`, isTruncated: false },
        h: { value: spec.html ?? `<p>${spec.subject} body</p>`, isTruncated: false },
      },
      textBody: [{ partId: "t", type: "text/plain" }],
      htmlBody: [{ partId: "h", type: "text/html" }],
    };
  });

  const set = await callOne(["Email/set", { accountId: acc, create: creations }, "es"]);
  const notCreated = (set.notCreated ?? {}) as Record<string, unknown>;
  if (Object.keys(notCreated).length > 0) {
    throw new Error(`Email/set notCreated: ${JSON.stringify(notCreated)}`);
  }
  const created = (set.created ?? {}) as Record<string, { id: Id }>;
  const ids = specs.map((_, i) => {
    const id = created[`m${i}`]?.id;
    if (!id) throw new Error(`Email/set did not create m${i}: ${JSON.stringify(set)}`);
    return id;
  });

  // Read back threadId (Email/set's created object doesn't reliably echo it across servers).
  const got = await callOne([
    "Email/get",
    { accountId: acc, ids, properties: ["id", "threadId"] },
    "eg",
  ]);
  const list = (got.list ?? []) as Array<{ id: Id; threadId: Id }>;
  const threadById = new Map(list.map((e) => [e.id, e.threadId]));
  return ids.map((id, i) => ({
    id,
    threadId: threadById.get(id) ?? "",
    messageId: messageIds[i] as string,
  }));
}

/**
 * Create a single multi-message conversation (a reply chain on one subject) so it collapses
 * to one row. Returns the messages oldest-first (the order Thread/get reports emailIds in).
 */
export async function createThread(mailboxId: Id, count: number): Promise<CreatedMessage[]> {
  const subject = `Thread ${suffix()}`;
  // Reserve a block, then assign ascending receivedAt within it (oldest message first, the
  // order Thread/get reports), all newer than any previously-created batch.
  const base = reserveBatch(count);
  const specs: MessageSpec[] = [];
  const refs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const messageId = `qelo-itest-thread-${suffix()}-${i}@example.test`;
    specs.push({
      subject: i === 0 ? subject : `Re: ${subject}`,
      messageId,
      receivedAt: isoNoMillis(base - (count - 1 - i) * HOUR_MS),
      ...(i > 0 ? { inReplyTo: refs[refs.length - 1], references: [...refs] } : {}),
    });
    refs.push(messageId);
  }
  return createMessages(mailboxId, specs);
}

/** Destroy emails by id (e.g. to force an anchor out of a live query result). */
export async function destroyEmails(ids: Id[]): Promise<void> {
  if (ids.length === 0) return;
  await callOne(["Email/set", { accountId: accountId(), destroy: ids }, "ed"]);
}

/** Toggle the $seen keyword on an email server-side (to exercise an Email/changes update). */
export async function setSeen(id: Id, seen: boolean): Promise<void> {
  await callOne([
    "Email/set",
    { accountId: accountId(), update: { [id]: { "keywords/$seen": seen ? true : null } } },
    "eu",
  ]);
}

/** True once the given email id is cached in the email store. */
export function isCached(id: Id): boolean {
  return id in emails;
}

/** Read a mailbox row from the store (or undefined). */
export function mailboxRow(id: Id) {
  return mailboxes[id];
}
