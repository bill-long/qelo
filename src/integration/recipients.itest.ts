// Recipient autocomplete (Phase 1) against a live Stalwart (CLAUDE.md forbids mocking). Seeds the
// Sent mailbox with messages carrying known to/cc recipients, then drives the real
// loadRecipientSuggestions store action and asserts it mines those addresses into a recency+frequency
// ranked index — proving the cursor-free Email/query→Email/get over Sent returns to/cc and that the
// derivation ranks by frequency and captures display names.

import process from "node:process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAP_CORE, CAP_MAIL, emailQuery, emailSet, methodResult } from "@/jmap/methods";
import type { EmailAddress, Id } from "@/jmap/types";
import { loadMailboxes, mailboxIdByRole } from "@/stores/mailboxes";
import {
  loadRecipientSuggestions,
  recipientSuggestions,
  resetRecipients,
  suggestionIndex,
} from "@/stores/recipients";
import { connectTestClient, disconnectTestClient, resetStores, testClient } from "./harness";

const ACCOUNT_EMAIL =
  process.env.QELO_TEST_EMAIL ?? process.env.QELO_SEED_EMAIL ?? "test@example.test";

interface SentSpec {
  subject: string;
  to?: EmailAddress[];
  cc?: EmailAddress[];
  receivedAt: string;
}

describe("recipient autocomplete", () => {
  const subjectsToClean: string[] = [];

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(() => {
    resetStores();
    resetRecipients();
  });
  afterEach(async () => {
    while (subjectsToClean.length > 0) {
      const subject = subjectsToClean.pop();
      if (subject) await destroyBySubject(subject).catch(() => {});
    }
  });

  function freshSubject(label: string): string {
    const subject = `itest-recip-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    subjectsToClean.push(subject);
    return subject;
  }

  /** Create the given messages directly in Sent (raw Email/set — createMessages can't set cc). */
  async function seedSent(sentId: Id, specs: SentSpec[]): Promise<void> {
    const client = testClient();
    const create: Record<string, Record<string, unknown>> = {};
    specs.forEach((spec, i) => {
      create[`m${i}`] = {
        mailboxIds: { [sentId]: true },
        keywords: { $seen: true },
        from: [{ name: "Test User", email: ACCOUNT_EMAIL }],
        ...(spec.to ? { to: spec.to } : {}),
        ...(spec.cc ? { cc: spec.cc } : {}),
        subject: spec.subject,
        receivedAt: spec.receivedAt,
        bodyValues: { b: { value: "body", isTruncated: false } },
        textBody: [{ partId: "b", type: "text/plain" }],
      };
    });
    const resp = await client.request(
      [emailSet(client.accountId, "s", { create })],
      [CAP_CORE, CAP_MAIL],
    );
    const notCreated = methodResult(resp, "s").notCreated as Record<string, unknown>;
    if (Object.keys(notCreated ?? {}).length > 0) {
      throw new Error(`seedSent notCreated: ${JSON.stringify(notCreated)}`);
    }
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
   * (Re)load the suggestion index until `email` appears in it (Stalwart indexes Email/query
   * asynchronously, so a freshly-seeded Sent message isn't queryable the instant the /set resolves).
   */
  async function loadUntil(email: string, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const lc = email.toLowerCase();
    for (;;) {
      resetRecipients();
      await loadRecipientSuggestions();
      if (suggestionIndex().some((s) => s.email.toLowerCase() === lc)) return;
      if (Date.now() >= deadline) {
        throw new Error(`Suggestion index never included ${email}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  it("mines past recipients from Sent, ranking by frequency and capturing display names", async () => {
    await loadMailboxes();
    const sentId = mailboxIdByRole("sent") as Id;
    expect(sentId, "the dev account exposes a Sent mailbox").toBeDefined();

    // Unique addresses so existing Sent data can't collide with or reorder the assertions. `alice`
    // is addressed twice (frequency 2), `bob` once with a display name. Future receivedAt keeps these
    // at the top of the newest-first scan window regardless of other Sent contents.
    const tag = Math.random().toString(36).slice(2, 8);
    const alice = `alice-${tag}@auto.test`;
    const bob = `bob-${tag}@auto.test`;

    await seedSent(sentId, [
      {
        subject: freshSubject("a"),
        to: [{ name: null, email: alice }],
        receivedAt: "2031-01-02T00:00:00Z",
      },
      {
        subject: freshSubject("b"),
        to: [{ name: null, email: alice }],
        cc: [{ name: "Bob Example", email: bob }],
        receivedAt: "2031-01-01T00:00:00Z",
      },
    ]);

    await loadUntil(alice);
    // bob may settle a beat later than alice; ensure both are present before asserting order.
    await loadUntil(bob);

    const index = suggestionIndex();
    const aliceEntry = index.find((s) => s.email.toLowerCase() === alice);
    const bobEntry = index.find((s) => s.email.toLowerCase() === bob);
    expect(aliceEntry, "alice was mined from Sent to/cc").toBeDefined();
    expect(bobEntry, "bob was mined from Sent cc").toBeDefined();
    // The display name on bob's cc entry rode through.
    expect(bobEntry?.name).toBe("Bob Example");

    // Frequency ranking: alice (2 messages) precedes bob (1) in the index order.
    const aliceRank = index.findIndex((s) => s.email.toLowerCase() === alice);
    const bobRank = index.findIndex((s) => s.email.toLowerCase() === bob);
    expect(aliceRank).toBeLessThan(bobRank);

    // The reactive selector matches on the shared tag substring, best-first, and honors the exclude
    // set (so an already-entered recipient isn't offered again).
    const both = recipientSuggestions(tag).map((s) => s.email.toLowerCase());
    expect(both).toEqual([alice, bob]);
    const excludingAlice = recipientSuggestions(tag, new Set([alice])).map((s) =>
      s.email.toLowerCase(),
    );
    expect(excludingAlice).toEqual([bob]);
  });
});
