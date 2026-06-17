import { createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
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
  type SetResult,
  setResult,
} from "@/jmap/methods";
import type { AddressBook, ContactCard, Id, SetError } from "@/jmap/types";
import type { EditableContact } from "@/lib/contacts";
import {
  createContactBody,
  createdCardFor,
  editableHasContent,
  editableToCard,
  editableToPatch,
} from "@/lib/contacts";
import { handleAuthFailure, jmap, session } from "./account";
import { syncCollection } from "./sync-collection";
import { selectedContactId, setSelectedContactId } from "./ui";

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
      CONTACTS_USING,
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
      CONTACTS_USING,
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
 * Save edits to an existing contact. `baseline` is the card the form was seeded from (its open-time
 * snapshot); the patch is the diff between THAT and the edits, so it carries only the properties the
 * user actually changed. Issued as ONE `ContactCard/set update` — a JSON-pointer patch that touches
 * only those properties, so a concurrent server-side change to a *different* property merges cleanly
 * instead of being clobbered (last-writer-wins only within the properties the user edited). The
 * rebuilt card is applied optimistically, then reconciled to server truth. ContactCard content is
 * mutable (unlike Email), so this is an in-place patch, not a create+destroy. Resolves with a
 * {@link SaveContactResult} (never rejects) so the form can surface a failure inline.
 *
 * Discipline mirrors the email mutations ([[jmap-set-quirks]] / [[qelo-review-checklist]]):
 * `requireNewState:false` (an all-failed /set omits newState on Stalwart; this path never persists
 * that cursor — sync owns it via ContactCard/changes); on a per-item refusal OR a transport error we
 * refetch the card so the view shows server truth rather than reverting to a possibly-stale local
 * snapshot, falling back to the baseline only if that refetch also fails. An empty patch (nothing
 * actually changed) is a no-op success.
 */
export async function saveContact(
  id: string,
  baseline: ContactCard,
  edits: EditableContact,
): Promise<SaveContactResult> {
  if (!contactCards[id]) return { ok: false, reason: "missing" };
  const accountId = contactsAccountId();
  if (!accountId) return { ok: false, reason: "no-account" };

  // Diff and rebuild against the form's open-time baseline (a plain card), not the live store proxy:
  // the patch is then exactly the user's delta, and the baseline doubles as the last-resort revert.
  const patch = editableToPatch(baseline, edits);
  if (Object.keys(patch).length === 0) return { ok: true }; // nothing changed

  const optimistic = editableToCard(baseline, edits);
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
    // The /set never applied — revert the optimistic write to server truth (or the baseline if the
    // refetch also fails), independent of the re-auth gate (the change didn't persist either way),
    // then raise that gate / report the error.
    await revertOptimistic(accountId, id, baseline);
    if (handleAuthFailure(err)) return { ok: false, reason: "auth" };
    console.error("ContactCard/set update failed:", err);
    return { ok: false, reason: "error" };
  }

  // The /set applied (fully, or with a per-item refusal). Reconcile to server truth: on success this
  // absorbs any re-keying/normalization; on a refusal it authoritatively undoes the optimistic write.
  try {
    await reconcileCard(accountId, id);
  } catch (err) {
    // A refetch blip. Raise the re-auth gate if applicable, but the gate must NOT skip the revert:
    // on a refusal the server rejected the optimistic write, so fall back to the baseline regardless
    // (else a token expiring between the /set and the reconcile leaves rejected data on screen). On
    // success the optimistic write ≈ server truth, so keep it.
    handleAuthFailure(err);
    if (refused) {
      setContactCards(
        produce((s) => {
          s[id] = baseline;
        }),
      );
    }
  }
  return refused ? { ok: false, reason: "refused", error: refused } : { ok: true };
}

// Best-effort revert of an optimistic write after the /set itself failed: refetch server truth, or
// restore the form's open-time baseline if even the refetch fails (so the view isn't stuck on a guess).
async function revertOptimistic(
  accountId: string,
  id: string,
  baseline: ContactCard,
): Promise<void> {
  try {
    await reconcileCard(accountId, id);
  } catch {
    setContactCards(
      produce((s) => {
        s[id] = baseline;
      }),
    );
  }
}

/** The outcome of a {@link createContact}: the new server id on success, else why it didn't persist. */
export type CreateContactResult =
  | { ok: true; id: Id }
  | {
      ok: false;
      reason: "empty" | "no-account" | "auth" | "refused" | "error";
      error?: SetError;
    };

/**
 * Create a new contact from the form's working copy in the chosen address book(s). Issued as ONE
 * `ContactCard/set create`; the server assigns the id and re-keys our creation id (`new` →
 * server id), exactly like the Email create path. On success the new card is written into the store
 * under its server id (seeded from the form, then reconciled to server truth to absorb any
 * normalization) and selected, so the contact opens immediately. Resolves with a
 * {@link CreateContactResult} (never rejects) so the form can surface a failure inline.
 *
 * Discipline mirrors saveContact / the email mutations ([[jmap-set-quirks]] / [[qelo-review-checklist]]):
 * `requireNewState:false` (an all-failed /set omits newState on Stalwart; this path never persists
 * that cursor — sync owns it via ContactCard/changes). A contentless working copy (no savable field
 * once blanks drop) is rejected without a round trip — the create-form analog of saveContact's empty
 * patch no-op (the form also gates Save on this). Nothing is written to the store until the server
 * confirms the create, so a refusal or transport error needs no rollback.
 */
export async function createContact(
  edits: EditableContact,
  addressBookIds: Record<string, true>,
): Promise<CreateContactResult> {
  if (!editableHasContent(edits)) return { ok: false, reason: "empty" };
  const accountId = contactsAccountId();
  if (!accountId) return { ok: false, reason: "no-account" };

  const body = createContactBody(edits, addressBookIds);
  const client = jmap();
  let result: SetResult<ContactCard>;
  try {
    const responses = await client.request(
      [contactCardSet(accountId, "set", { create: { new: body } })],
      CONTACTS_USING,
    );
    result = setResult<ContactCard>(responses, "set", { requireNewState: false });
  } catch (err) {
    if (handleAuthFailure(err)) return { ok: false, reason: "auth" };
    console.error("ContactCard/set create failed:", err);
    return { ok: false, reason: "error" };
  }

  const refused = result.notCreated.new;
  if (refused) return { ok: false, reason: "refused", error: refused };
  const id = result.created.new?.id;
  if (!id) {
    // Created without a refusal but the server returned no id — it can't be addressed. Treat as an
    // error rather than guessing; the next Contacts-view open re-syncs and surfaces it.
    console.error("ContactCard/set create returned no id");
    return { ok: false, reason: "error" };
  }

  // Seed the store from the form so the new contact renders at once, select it, then reconcile to
  // server truth (best-effort — a refetch blip leaves the seeded card, which the next sync corrects).
  setContactCards(
    produce((s) => {
      s[id] = createdCardFor(id, edits, addressBookIds);
    }),
  );
  setSelectedContactId(id);
  try {
    await reconcileCard(accountId, id);
  } catch (err) {
    handleAuthFailure(err);
  }
  return { ok: true, id };
}

/** The outcome of a {@link deleteContact}: ok on success, else why it didn't delete. */
export type DeleteContactResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "no-account" | "auth" | "refused" | "error";
      error?: SetError;
    };

/**
 * Delete a contact. Issued as ONE `ContactCard/set destroy`. The card is pruned from the store
 * optimistically (and the selection cleared if it pointed at it), then the deletion is confirmed or
 * reversed against the server. Contacts have NO ordered id-list (unlike email's threadList.ids) — the
 * store is just the `contactCards` map plus the selection — so the optimistic prune is a map delete +
 * a selection clear, and a restore is a re-insert + (if still applicable) re-select. Resolves with a
 * {@link DeleteContactResult} (never rejects) so the caller can surface a failure inline.
 *
 * Discipline mirrors the email `deleteForever` ([[jmap-set-quirks]] / [[qelo-review-checklist]]):
 * `requireNewState:false` (a fully-refused destroy omits newState on Stalwart; this path syncs via
 * ContactCard/changes, not this token); a `notFound` refusal counts as gone (the card was already
 * destroyed elsewhere — keep it pruned, that's the desired end state); only a substantive refusal
 * (forbidden, etc.) or a transport error restores the card. The restore is guarded like
 * `deleteForever`'s spliceBack: it re-inserts only if a concurrent sync hasn't already re-added the
 * card, and re-selects only if nothing else was selected across the await.
 */
export async function deleteContact(id: string): Promise<DeleteContactResult> {
  const card = contactCards[id];
  if (!card) return { ok: false, reason: "missing" };
  const accountId = contactsAccountId();
  if (!accountId) return { ok: false, reason: "no-account" };

  // Snapshot the card to a plain object before pruning — the restore value must not be a live store
  // proxy (which is emptied by the delete). Remember whether it was the selected card so a restore
  // re-selects only what the prune cleared.
  const removed = structuredClone(unwrap(card)) as ContactCard;
  const wasSelected = selectedContactId() === id;

  setContactCards(
    produce((s) => {
      delete s[id];
    }),
  );
  if (wasSelected) setSelectedContactId(null);

  const client = jmap();
  let refused: SetError | undefined;
  try {
    const responses = await client.request(
      [contactCardSet(accountId, "set", { destroy: [id] })],
      CONTACTS_USING,
    );
    const r = setResult<ContactCard>(responses, "set", { requireNewState: false });
    // A notFound refusal means the card was already gone (destroyed elsewhere) — keep it pruned.
    // Only a substantive refusal leaves it on the server and warrants a restore.
    const err = r.notDestroyed[id];
    if (err && err.type !== "notFound") refused = err;
  } catch (err) {
    // The destroy never applied — restore the card + selection, independent of the re-auth gate
    // (the deletion didn't persist either way), then raise that gate / report the error.
    restoreContact(removed, wasSelected);
    if (handleAuthFailure(err)) return { ok: false, reason: "auth" };
    console.error("ContactCard/set destroy failed:", err);
    return { ok: false, reason: "error" };
  }

  if (refused) {
    restoreContact(removed, wasSelected);
    return { ok: false, reason: "refused", error: refused };
  }
  return { ok: true };
}

// Reverse an optimistic delete the server refused (or that a transport error left unconfirmed).
// Guarded like deleteForever's spliceBack: re-insert only if a concurrent sync hasn't already
// re-added the card (with possibly-newer data), and re-select only if nothing else was selected
// across the await — so a refusal doesn't clobber newer state or yank the user off a contact they
// opened in the meantime.
function restoreContact(card: ContactCard, reselect: boolean): void {
  if (!contactCards[card.id]) {
    setContactCards(
      produce((s) => {
        s[card.id] = card;
      }),
    );
  }
  if (reselect && selectedContactId() === null) setSelectedContactId(card.id);
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
