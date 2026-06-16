import { createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { drainChanges } from "@/jmap/changes";
import type { JmapClient } from "@/jmap/client";
import {
  addressBookChanges,
  addressBookGet,
  CAP_CONTACTS,
  CAP_CORE,
  contactCardChanges,
  contactCardGet,
  contactCardQuery,
  idsFromContactQuery,
  methodResult,
} from "@/jmap/methods";
import type { AddressBook, ContactCard, MethodCall } from "@/jmap/types";
import { handleAuthFailure, jmap, session } from "./account";

export const [addressBooks, setAddressBooks] = createStore<Record<string, AddressBook>>({});
export const [contactCards, setContactCards] = createStore<Record<string, ContactCard>>({});

const CONTACTS_USING = [CAP_CORE, CAP_CONTACTS];

// Sync cursors (from /get and /changes), used as `sinceState` for the *_changes calls. Plain
// module state — they're sync cursors, not reactive UI state (same as mailboxState/emailState).
let addressBookState = "";
let contactState = "";

// Contacts load lazily on first open of the Contacts view (not on connect), so most mail-only
// sessions never fetch them. `contactsReady` is reactive so the UI can tell "loading" from
// "loaded but empty"; it also gates the push-driven sync — a change pushed before the view was
// ever opened is ignored (the eventual lazy load fetches fresh). `loadInFlight` dedupes concurrent
// opens. Both reset by resetContacts.
export const [contactsReady, setContactsReady] = createSignal(false);
let loadInFlight: Promise<void> | null = null;

/**
 * The account that holds contacts, or null if the session exposes none. Resolved from
 * `primaryAccounts[urn:…:contacts]` rather than assuming the mail account — they coincide on the
 * dev server, but a shared/secondary account could differ. Reactive (reads the `session` signal).
 */
export function contactsAccountId(): string | null {
  return session()?.primaryAccounts[CAP_CONTACTS] ?? null;
}

/**
 * Whether this account can do contacts: the server advertises the capability AND a primary
 * contacts account exists. Reactive — the view switch gates the Contacts tab on it, so the tab
 * is enabled only once a contacts-capable session is connected and fails safe (disabled) otherwise.
 */
export function contactsAvailable(): boolean {
  const s = session();
  return s ? CAP_CONTACTS in s.capabilities && contactsAccountId() !== null : false;
}

// Fetch address books + all contact cards in one round trip (AddressBook/get, then the canonical
// ContactCard/query → ContactCard/get chain). Captures both state cursors. Throws on failure —
// loadContacts wraps it with the load-once guard + error handling.
async function fetchContacts(): Promise<void> {
  const accountId = contactsAccountId();
  if (!accountId) return; // capability absent — nothing to load (view switch keeps the tab disabled)
  const client = jmap();
  const responses = await client.request(
    [
      addressBookGet(accountId, "ab"),
      // No sort: Stalwart rejects ContactCard sort (lib/contacts.ts compareContacts sorts the
      // list client-side). No limit: Phase 1 loads the whole book to sort/search locally.
      contactCardQuery(accountId, "q"),
      contactCardGet(accountId, "cc", { idsRef: idsFromContactQuery("q") }),
    ],
    CONTACTS_USING,
  );

  const abResult = methodResult(responses, "ab");
  if (typeof abResult.state === "string") addressBookState = abResult.state;
  const books: Record<string, AddressBook> = {};
  for (const b of (abResult.list ?? []) as AddressBook[]) books[b.id] = b;
  setAddressBooks(reconcile(books));

  const ccResult = methodResult(responses, "cc");
  if (typeof ccResult.state === "string") contactState = ccResult.state;
  const cards: Record<string, ContactCard> = {};
  for (const c of (ccResult.list ?? []) as ContactCard[]) cards[c.id] = c;
  setContactCards(reconcile(cards));

  setContactsReady(true);
}

/**
 * Load contacts once. Idempotent — returns immediately if already loaded, joins an in-flight load
 * otherwise — and never rejects (an auth failure raises the re-auth gate; anything else is logged),
 * so a caller (the Contacts view's onMount, or branch 2's autocomplete source) can fire it freely.
 * A failed load leaves `loaded` false so the next open retries.
 */
export function loadContacts(): Promise<void> {
  if (contactsReady()) return Promise.resolve();
  if (loadInFlight) return loadInFlight;
  loadInFlight = fetchContacts()
    .catch((err) => {
      if (!handleAuthFailure(err)) console.error("Contacts load failed:", err);
    })
    .finally(() => {
      loadInFlight = null;
    });
  return loadInFlight;
}

// Drain one collection's /changes, refetch the created+updated rows (minus any also destroyed in
// the same burst — destroyed wins), upsert/remove them, and return the drained newState. Identical
// shape for AddressBook and ContactCard, so it's written once (mirrors syncMailboxes). The caller
// advances the module cursor ONLY from the returned value — and only after this resolves — so a
// throw mid-drain leaves the cursor at its old value and the next sync re-drains (no stranded gap).
async function syncCollection<T extends { id: string }>(
  client: JmapClient,
  sinceState: string,
  changesCall: (since: string) => MethodCall,
  getCall: (ids: string[]) => MethodCall,
  upsert: (list: T[]) => void,
  remove: (ids: string[]) => void,
): Promise<string> {
  const result = await drainChanges(client, sinceState, changesCall);
  const destroyed = new Set(result.destroyed);
  const changed = new Set<string>();
  for (const id of [...result.created, ...result.updated]) {
    if (!destroyed.has(id)) changed.add(id);
  }
  if (changed.size > 0) {
    const got = await client.request([getCall([...changed])], CONTACTS_USING);
    upsert((methodResult(got, "get").list ?? []) as T[]);
  }
  if (destroyed.size > 0) remove([...destroyed]);
  return result.newState;
}

/**
 * Apply server-pushed contact changes incrementally (AddressBook + ContactCard), each with its own
 * cursor. No-op until contacts have been loaded (a push before the view opened is ignored; the lazy
 * load will fetch current state). Falls back to a full reload on cannotCalculateChanges / transient
 * failure, which also resets the cursors. Raises the re-auth gate on an auth failure.
 */
export async function syncContacts(): Promise<void> {
  if (!contactsReady()) return;
  const accountId = contactsAccountId();
  if (!accountId) return;
  const client = jmap();
  try {
    addressBookState = await syncCollection<AddressBook>(
      client,
      addressBookState,
      (since) => addressBookChanges(accountId, since, "abc"),
      (ids) => addressBookGet(accountId, "get", { ids }),
      (list) =>
        setAddressBooks(
          produce((s) => {
            for (const b of list) s[b.id] = b;
          }),
        ),
      (ids) =>
        setAddressBooks(
          produce((s) => {
            for (const id of ids) delete s[id];
          }),
        ),
    );
    contactState = await syncCollection<ContactCard>(
      client,
      contactState,
      (since) => contactCardChanges(accountId, since, "ccc"),
      (ids) => contactCardGet(accountId, "get", { ids }),
      (list) =>
        setContactCards(
          produce((s) => {
            for (const c of list) s[c.id] = c;
          }),
        ),
      (ids) =>
        setContactCards(
          produce((s) => {
            for (const id of ids) delete s[id];
          }),
        ),
    );
  } catch (err) {
    if (handleAuthFailure(err)) return;
    // cannotCalculateChanges (or a transient failure) → rebuild from scratch, which also resets
    // the cursors to a usable baseline. Clear ready so loadContacts actually refetches.
    setContactsReady(false);
    await loadContacts();
  }
}

/** Test seam: drop all contacts state so a suite starts clean (wired into the harness resetStores). */
export function resetContacts(): void {
  setAddressBooks(reconcile({}));
  setContactCards(reconcile({}));
  addressBookState = "";
  contactState = "";
  setContactsReady(false);
  loadInFlight = null;
}
