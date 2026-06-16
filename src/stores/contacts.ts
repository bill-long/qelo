import { createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
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
  contactCardSet,
  idsFromContactQuery,
  methodResult,
  setResult,
} from "@/jmap/methods";
import type { AddressBook, ContactCard, MethodCall, SetError } from "@/jmap/types";
import type { EditableContact } from "@/lib/contacts";
import { editableToCard, editableToPatch } from "@/lib/contacts";
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
 * A failed load leaves `contactsReady` false so the next open retries.
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
  const result = await drainChanges(client, sinceState, changesCall, CONTACTS_USING);
  const destroyed = new Set(result.destroyed);
  const changed = new Set<string>();
  for (const id of [...result.created, ...result.updated]) {
    if (!destroyed.has(id)) changed.add(id);
  }
  if (changed.size > 0) {
    // Read the response by the built call's own id (call[2]) rather than a hardcoded "get", so a
    // getCall that uses a different call id can't silently read the wrong method response.
    const call = getCall([...changed]);
    const got = await client.request([call], CONTACTS_USING);
    upsert((methodResult(got, call[2]).list ?? []) as T[]);
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

// Refetch one card and apply server truth: upsert it (absorbing any server re-keying/normalization
// of a just-applied edit), or drop it from the store if the server no longer returns it (destroyed
// elsewhere). A partial fetch — does NOT advance contactState (the push-driven drain owns that
// cursor, exactly like emails' reconcileRefused). Throws on a transport/method failure so the
// caller can fall back; the auth case is surfaced by handleAuthFailure at the call site.
async function reconcileCard(accountId: string, id: string): Promise<void> {
  const client = jmap();
  const got = await client.request(
    [contactCardGet(accountId, "rc", { ids: [id] })],
    CONTACTS_USING,
  );
  const list = (methodResult(got, "rc").list ?? []) as ContactCard[];
  setContactCards(
    produce((s) => {
      if (list.length === 0) delete s[id];
      else for (const c of list) s[c.id] = c;
    }),
  );
}

/** The outcome of a {@link saveContact}: ok on success/no-op, else why it didn't persist. */
export type SaveContactResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "no-account" | "auth" | "refused" | "error";
      error?: SetError;
    };

/**
 * Save edits to an existing contact: build the minimal whole-property patch from the form's working
 * copy, optimistically apply the rebuilt card to the store, issue ONE `ContactCard/set update`, then
 * reconcile to server truth. ContactCard content is mutable (unlike Email), so this is an in-place
 * patch, not a create+destroy. Resolves with a {@link SaveContactResult} (never rejects) so the form
 * can surface a failure inline.
 *
 * Discipline mirrors the email mutations ([[jmap-set-quirks]] / [[qelo-review-checklist]]):
 * `requireNewState:false` (an all-failed /set omits newState on Stalwart; this path never persists
 * that cursor — sync owns it via ContactCard/changes); on a per-item refusal OR a transport error we
 * refetch the card so the view shows server truth rather than reverting to a possibly-stale local
 * snapshot, falling back to the pre-optimistic snapshot only if that refetch also fails. An empty
 * patch (nothing actually changed) is a no-op success.
 */
export async function saveContact(id: string, edits: EditableContact): Promise<SaveContactResult> {
  const card = contactCards[id];
  if (!card) return { ok: false, reason: "missing" };
  const accountId = contactsAccountId();
  if (!accountId) return { ok: false, reason: "no-account" };

  const patch = editableToPatch(card, edits);
  if (Object.keys(patch).length === 0) return { ok: true }; // nothing changed

  // Snapshot the pre-optimistic card (a plain clone, not the live store proxy) for the last-resort
  // revert, and compute the optimistic card BEFORE mutating the store (both read `card`).
  const snapshot = structuredClone(unwrap(card)) as ContactCard;
  const optimistic = editableToCard(card, edits);
  setContactCards(
    produce((s) => {
      s[id] = optimistic;
    }),
  );

  const client = jmap();
  let refused: SetError | undefined;
  try {
    const responses = await client.request(
      [contactCardSet(accountId, "set", { update: { [id]: patch } })],
      CONTACTS_USING,
    );
    refused = setResult<ContactCard>(responses, "set", { requireNewState: false }).notUpdated[id];
  } catch (err) {
    if (handleAuthFailure(err)) return { ok: false, reason: "auth" };
    // The /set never applied — revert the optimistic write to server truth (or the snapshot if the
    // refetch also fails), then report the error.
    await revertOptimistic(accountId, id, snapshot);
    console.error("ContactCard/set update failed:", err);
    return { ok: false, reason: "error" };
  }

  // The /set applied (fully, or with a per-item refusal). Reconcile to server truth: on success this
  // absorbs any re-keying/normalization; on a refusal it authoritatively undoes the optimistic write.
  try {
    await reconcileCard(accountId, id);
  } catch (err) {
    // A refetch blip: keep the optimistic write on success (it ≈ server truth), but on a refusal we
    // couldn't fetch truth to revert to — fall back to the pre-optimistic snapshot.
    if (!handleAuthFailure(err) && refused) {
      setContactCards(
        produce((s) => {
          s[id] = snapshot;
        }),
      );
    }
  }
  return refused ? { ok: false, reason: "refused", error: refused } : { ok: true };
}

// Best-effort revert of an optimistic write after the /set itself failed: refetch server truth, or
// restore the pre-optimistic snapshot if even the refetch fails (so the view isn't stuck on a guess).
async function revertOptimistic(
  accountId: string,
  id: string,
  snapshot: ContactCard,
): Promise<void> {
  try {
    await reconcileCard(accountId, id);
  } catch {
    setContactCards(
      produce((s) => {
        s[id] = snapshot;
      }),
    );
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
