// Read-only contacts against a live Stalwart (CLAUDE.md forbids mocking). Seeds JSContact cards via
// a raw ContactCard/set, then drives the real loadContacts/syncContacts store actions and asserts
// the AddressBook + ContactCard objects load, sort by name client-side, and that a server-side
// create/destroy is picked up incrementally by syncContacts (the AddressBook/ContactCard /changes
// cursors).

import { unwrap } from "solid-js/store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAP_CONTACTS, CAP_CORE, methodResult } from "@/jmap/methods";
import type { ContactCard, Id } from "@/jmap/types";
import { cardToEditable } from "@/lib/contacts";
import {
  addressBooks,
  contactCards,
  contactsAccountId,
  contactsReady,
  loadContacts,
  resetContacts,
  saveContact,
  syncContacts,
} from "@/stores/contacts";
import { connectTestClient, disconnectTestClient, resetStores, testClient } from "./harness";

const CONTACTS_USING = [CAP_CORE, CAP_CONTACTS];

// Resolve the CONTACTS primary account exactly as the store does (primaryAccounts[contacts]), not
// the mail account — they coincide on the dev server, but the fixtures must target the same account
// the store reads so the test stays correct if they ever differ.
function contactsAcct(): Id {
  const id = contactsAccountId();
  if (!id) throw new Error("session exposes no contacts account");
  return id;
}

interface CardSpec {
  fullName: string;
  email?: string;
  org?: string;
}

describe("contacts (live Stalwart)", () => {
  const createdIds: Id[] = [];

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(() => {
    resetStores(); // also resets contacts state
  });
  afterEach(async () => {
    if (createdIds.length > 0) {
      await destroyCards(createdIds.splice(0)).catch(() => {});
    }
  });

  /** The id of the account's default address book (every seeded card lands here). */
  async function defaultBookId(): Promise<Id> {
    const client = testClient();
    const resp = await client.request(
      [["AddressBook/get", { accountId: contactsAcct(), ids: null }, "ab"]],
      CONTACTS_USING,
    );
    const books = (methodResult(resp, "ab").list ?? []) as Array<{ id: Id; isDefault: boolean }>;
    const def = books.find((b) => b.isDefault) ?? books[0];
    if (!def) throw new Error("account exposes no address book");
    return def.id;
  }

  /** Create JSContact cards in the default book; returns their server ids (also tracked for cleanup). */
  async function seedCards(bookId: Id, specs: CardSpec[]): Promise<Id[]> {
    const client = testClient();
    const create: Record<string, Record<string, unknown>> = {};
    specs.forEach((spec, i) => {
      create[`n${i}`] = {
        "@type": "Card",
        version: "1.0",
        addressBookIds: { [bookId]: true },
        name: { full: spec.fullName },
        ...(spec.email ? { emails: { e1: { address: spec.email } } } : {}),
        ...(spec.org ? { organizations: { o1: { name: spec.org } } } : {}),
      };
    });
    const resp = await client.request(
      [["ContactCard/set", { accountId: contactsAcct(), create }, "cs"]],
      CONTACTS_USING,
    );
    const result = methodResult(resp, "cs");
    const notCreated = (result.notCreated ?? {}) as Record<string, unknown>;
    if (Object.keys(notCreated).length > 0) {
      throw new Error(`ContactCard/set notCreated: ${JSON.stringify(notCreated)}`);
    }
    const created = (result.created ?? {}) as Record<string, { id: Id }>;
    const ids = specs.map((_, i) => {
      const id = created[`n${i}`]?.id;
      if (!id) throw new Error(`ContactCard/set did not create n${i}`);
      createdIds.push(id);
      return id;
    });
    return ids;
  }

  async function destroyCards(ids: Id[]): Promise<void> {
    if (ids.length === 0) return;
    const client = testClient();
    await client.request(
      [["ContactCard/set", { accountId: contactsAcct(), destroy: ids }, "cd"]],
      CONTACTS_USING,
    );
  }

  /** (Re)load contacts until card `id` is in the store (ContactCard/query may index a beat late). */
  async function loadUntil(id: Id, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      resetContacts();
      await loadContacts();
      if (id in contactCards) return;
      if (Date.now() >= deadline) throw new Error(`Contact ${id} never appeared in the store`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  it("loads address books + cards, capturing names/emails", async () => {
    const bookId = await defaultBookId();
    const tag = Math.random().toString(36).slice(2, 8);
    const [zoeId, aaronId] = (await seedCards(bookId, [
      { fullName: `Zoe ${tag}`, email: `zoe-${tag}@auto.test`, org: `Org ${tag}` },
      { fullName: `Aaron ${tag}`, email: `aaron-${tag}@auto.test` },
    ])) as [Id, Id];

    await loadUntil(zoeId);
    await loadUntil(aaronId);

    expect(contactsReady()).toBe(true);
    // The default address book loaded with its rights.
    expect(addressBooks[bookId]?.myRights.mayRead).toBe(true);

    const zoe = contactCards[zoeId];
    const aaron = contactCards[aaronId];
    expect(zoe?.name?.full).toBe(`Zoe ${tag}`);
    expect(zoe?.emails?.e1?.address).toBe(`zoe-${tag}@auto.test`);
    expect(zoe?.organizations?.o1?.name).toBe(`Org ${tag}`);
    expect(aaron?.name?.full).toBe(`Aaron ${tag}`);
    expect(aaron?.addressBookIds?.[bookId]).toBe(true);
  });

  it("picks up a server-side create and destroy via syncContacts", async () => {
    const bookId = await defaultBookId();
    const tag = Math.random().toString(36).slice(2, 8);
    const [firstId] = (await seedCards(bookId, [{ fullName: `First ${tag}` }])) as [Id];

    await loadUntil(firstId);
    expect(firstId in contactCards).toBe(true);

    // Create a second card server-side, then sync — it should appear without a full reload.
    const [secondId] = (await seedCards(bookId, [{ fullName: `Second ${tag}` }])) as [Id];
    await syncUntil(() => secondId in contactCards);
    expect(contactCards[secondId]?.name?.full).toBe(`Second ${tag}`);

    // Destroy the first card server-side, then sync — it should be removed from the store.
    await destroyCards([firstId]);
    createdIds.splice(createdIds.indexOf(firstId), 1);
    await syncUntil(() => !(firstId in contactCards));
    expect(firstId in contactCards).toBe(false);
  });

  /** The card from the store, or throw — keeps the tests free of `!` non-null assertions. */
  function requireCard(id: Id): ContactCard {
    const c = contactCards[id];
    if (!c) throw new Error(`card ${id} not in the store`);
    return c;
  }

  /** Create one card from a raw JSContact body (richer than seedCards); returns its server id. */
  async function seedRawCard(body: Record<string, unknown>): Promise<Id> {
    const client = testClient();
    const resp = await client.request(
      [["ContactCard/set", { accountId: contactsAcct(), create: { n0: body } }, "cs"]],
      CONTACTS_USING,
    );
    const result = methodResult(resp, "cs");
    const notCreated = (result.notCreated ?? {}) as Record<string, unknown>;
    if (Object.keys(notCreated).length > 0) {
      throw new Error(`ContactCard/set notCreated: ${JSON.stringify(notCreated)}`);
    }
    const id = ((result.created ?? {}) as Record<string, { id: Id }>).n0?.id;
    if (!id) throw new Error("seedRawCard did not create n0");
    createdIds.push(id);
    return id;
  }

  it("saveContact edits a card: name change, leaf carry-through, removal, and a new entry", async () => {
    const bookId = await defaultBookId();
    const tag = Math.random().toString(36).slice(2, 8);
    // A rich card: an email carrying pref + contexts (the un-edited sub-fields a whole-property patch
    // must carry through), plus an organization we'll remove.
    const id = await seedRawCard({
      "@type": "Card",
      version: "1.0",
      addressBookIds: { [bookId]: true },
      name: { full: `Before ${tag}` },
      emails: { e1: { address: `before-${tag}@auto.test`, pref: 1, contexts: { work: true } } },
      organizations: { o1: { name: `Org ${tag}` } },
    });
    await loadUntil(id);

    const baseline = structuredClone(unwrap(requireCard(id))) as ContactCard;
    const editable = cardToEditable(baseline);
    editable.nameFull = `After ${tag}`;
    const firstEmail = editable.emails[0];
    if (firstEmail) firstEmail.value = `after-${tag}@auto.test`; // change address, keep pref/contexts
    editable.organizations = []; // remove the whole organizations property
    editable.phones.push({ key: null, value: "+1-555-0199" }); // add a new entry

    const result = await saveContact(id, baseline, editable);
    expect(result).toEqual({ ok: true });

    // saveContact reconciles to server truth after the set, so the store holds the persisted card.
    const saved = contactCards[id];
    expect(saved?.name?.full).toBe(`After ${tag}`);
    const email = Object.values(saved?.emails ?? {})[0];
    expect(email?.address).toBe(`after-${tag}@auto.test`);
    expect(email?.pref).toBe(1); // carried through
    expect(email?.contexts).toEqual({ work: true }); // carried through
    expect(saved?.organizations).toBeUndefined(); // removed
    expect(Object.values(saved?.phones ?? {})[0]?.number).toBe("+1-555-0199"); // added

    // Persisted: a fresh reload from the server shows the same edits.
    await loadUntil(id);
    expect(contactCards[id]?.name?.full).toBe(`After ${tag}`);
    expect(contactCards[id]?.organizations).toBeUndefined();
  });

  it("saveContact patches only the user's delta, merging with a concurrent change to another field", async () => {
    const bookId = await defaultBookId();
    const tag = Math.random().toString(36).slice(2, 8);
    const id = await seedRawCard({
      "@type": "Card",
      version: "1.0",
      addressBookIds: { [bookId]: true },
      name: { full: `Concurrent ${tag}` },
      emails: { e1: { address: `before-${tag}@auto.test` } },
    });
    await loadUntil(id);

    // The form's baseline + edits: change only the name, never touch the email.
    const baseline = structuredClone(unwrap(requireCard(id))) as ContactCard;
    const editable = cardToEditable(baseline);
    editable.nameFull = `Renamed ${tag}`;

    // A concurrent server-side edit to a DIFFERENT property (the email) lands before we save.
    await testClient().request(
      [
        [
          "ContactCard/set",
          {
            accountId: contactsAcct(),
            update: { [id]: { "emails/e1/address": `concurrent-${tag}@auto.test` } },
          },
          "u",
        ],
      ],
      CONTACTS_USING,
    );

    const result = await saveContact(id, baseline, editable);
    expect(result).toEqual({ ok: true });

    // The name is the user's edit; the concurrent email change SURVIVES (the patch never touched it).
    expect(contactCards[id]?.name?.full).toBe(`Renamed ${tag}`);
    expect(Object.values(contactCards[id]?.emails ?? {})[0]?.address).toBe(
      `concurrent-${tag}@auto.test`,
    );
  });

  it("saveContact is a clean no-op when nothing changed", async () => {
    const bookId = await defaultBookId();
    const tag = Math.random().toString(36).slice(2, 8);
    const [id] = (await seedCards(bookId, [{ fullName: `Noop ${tag}` }])) as [Id];
    await loadUntil(id);
    // An untouched working copy yields an empty patch — saveContact returns ok without a round trip.
    const baseline = structuredClone(unwrap(requireCard(id))) as ContactCard;
    const result = await saveContact(id, baseline, cardToEditable(baseline));
    expect(result).toEqual({ ok: true });
    expect(contactCards[id]?.name?.full).toBe(`Noop ${tag}`);
  });

  /** Run syncContacts until `pred` holds (ContactCard/changes can lag the /set by a beat). */
  async function syncUntil(pred: () => boolean, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await syncContacts();
      if (pred()) return;
      if (Date.now() >= deadline) throw new Error("syncContacts never reached the expected state");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});
