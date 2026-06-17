// Pure helpers for the read-only contacts view: derive a display name and a primary/ordered
// email from a JSContact Card, and a stable sort comparator for the list. No SolidJS, no JMAP
// client — data → data, unit-tested in isolation. Reused by the recipient-autocomplete contacts
// source (branch 2), so the display-name + primary-email logic lives here, not in a component.
//
// JSContact (RFC 9553) leaves almost everything optional and stores sub-objects in id-keyed maps
// whose keys are server-assigned (not meaningful) — so we iterate values in insertion order, never
// keys, and guard every access (noUncheckedIndexedAccess makes map reads `T | undefined`).

import type { ContactCardPatch } from "@/jmap/methods";
import type {
  AddressBook,
  CardAddress,
  CardEmail,
  CardName,
  CardNote,
  CardOnlineService,
  CardOrganization,
  CardPhone,
  CardTitle,
  ContactCard,
} from "@/jmap/types";

/**
 * Assemble a name string from the card's structured `name.components` (RFC 9553 §2.2.1). Components
 * are joined in their array order — the server orders them, and `isOrdered` signals that order is
 * authoritative — skipping `separator` components (which carry literal punctuation we don't want to
 * duplicate around the values). Returns "" when there's nothing usable.
 */
function nameFromComponents(card: ContactCard): string {
  const components = card.name?.components;
  if (!components) return "";
  return components
    .filter((c) => c.kind !== "separator" && c.value.trim() !== "")
    .map((c) => c.value.trim())
    .join(" ")
    .trim();
}

/**
 * The best human-readable name for a card, by precedence: `name.full` → joined `name.components` →
 * first organization name → primary email → first nickname → a stable fallback. Never returns an
 * empty string, so a list row / autocomplete label always has something to show.
 */
export function contactDisplayName(card: ContactCard): string {
  const full = card.name?.full?.trim();
  if (full) return full;

  const composed = nameFromComponents(card);
  if (composed) return composed;

  for (const org of Object.values(card.organizations ?? {})) {
    const name = org?.name?.trim();
    if (name) return name;
  }

  const email = primaryEmail(card);
  if (email) return email;

  for (const nick of Object.values(card.nicknames ?? {})) {
    const name = nick?.name?.trim();
    if (name) return name;
  }

  return "(no name)";
}

/**
 * The card's nominal display name for an autocomplete label, or null when it has none. Like
 * {@link contactDisplayName} but WITHOUT its email / "(no name)" fallbacks: a recipient suggestion
 * already shows the address, so echoing it back as the "name" — or worse, surfacing a *different*
 * email of a multi-address card as the name — is noise. Returns name.full → components → org →
 * nickname when present, else null. Reused by the recipient-autocomplete contacts source.
 */
export function contactNominalName(card: ContactCard): string | null {
  const display = contactDisplayName(card);
  if (display === "(no name)") return null;
  // contactDisplayName falls back to primaryEmail when the card carries no nominal name; any of the
  // card's own addresses is an address, not a name — drop it so the label stays the bare email.
  const addresses = new Set(sortedEmails(card).map((e) => e.address.toLowerCase()));
  return addresses.has(display.toLowerCase()) ? null : display;
}

// Order entries carrying an optional JSContact `pref` (1 = most preferred; absent = least). Stable:
// equal/absent prefs keep their server insertion order (Object.values preserves it).
function byPref<T extends { pref?: number }>(values: T[]): T[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => {
      const pa = a.value.pref ?? Number.POSITIVE_INFINITY;
      const pb = b.value.pref ?? Number.POSITIVE_INFINITY;
      return pa - pb || a.index - b.index;
    })
    .map((entry) => entry.value);
}

/** The card's emails ordered by preference — the order the detail pane lists them. */
export function sortedEmails(card: ContactCard): CardEmail[] {
  return byPref(
    Object.values(card.emails ?? {}).filter((e): e is CardEmail => Boolean(e?.address)),
  );
}

/** The card's most-preferred email address, or undefined when it has none. */
export function primaryEmail(card: ContactCard): string | undefined {
  return sortedEmails(card)[0]?.address;
}

/**
 * Compare two cards for the contact list: by display name (locale-aware, case/accent-insensitive),
 * tie-broken by id so the order is stable across renders (and deterministic in tests). This is the
 * client-side sort Qelo applies because Stalwart rejects server-side ContactCard sorting.
 */
export function compareContacts(a: ContactCard, b: ContactCard): number {
  const byName = contactDisplayName(a).localeCompare(contactDisplayName(b), undefined, {
    sensitivity: "base",
  });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/** Whether a card belongs to address book `bookId`; a null `bookId` (the "All contacts" pseudo-book)
 * matches every card. */
export function contactInBook(card: ContactCard, bookId: string | null): boolean {
  return bookId === null ? true : card.addressBookIds?.[bookId] === true;
}

/**
 * Whether a card matches a search `query` (case-insensitive substring of its display name, any
 * nickname, email address, or organization name). An empty/whitespace query matches everything —
 * the list shows all contacts until the user types. Nicknames are searched even when they aren't
 * the chosen display name, so typing a nickname still finds the contact. (Phones aren't searched:
 * formatting like `+1-555` makes substring matching on numbers unreliable.) Pure + unit-tested.
 */
export function contactMatchesQuery(card: ContactCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (contactDisplayName(card).toLowerCase().includes(q)) return true;
  for (const nick of Object.values(card.nicknames ?? {})) {
    if (nick?.name?.toLowerCase().includes(q)) return true;
  }
  for (const email of Object.values(card.emails ?? {})) {
    if (email?.address?.toLowerCase().includes(q)) return true;
  }
  for (const org of Object.values(card.organizations ?? {})) {
    if (org?.name?.toLowerCase().includes(q)) return true;
  }
  return false;
}

/**
 * Order address books for the sidebar: the default book first, then by the server `sortOrder`,
 * then by name (locale-aware), tie-broken by id for stability.
 */
export function compareAddressBooks(a: AddressBook, b: AddressBook): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

/**
 * Whether the card can be edited: at least one of the address books it belongs to grants
 * `mayWrite`. The single gate the edit affordance uses, so a card in only read-only books shows no
 * edit UI rather than letting the user hit a server refusal. Reactive callers pass the live
 * `addressBooks` store. (Branch 5's delete will mirror this on `mayDelete`.)
 */
export function cardMayWrite(card: ContactCard, books: Record<string, AddressBook>): boolean {
  // Check the membership value is true (not just the key's presence), matching contactInBook — a
  // card carrying an addressBookId mapped to a falsy value isn't actually in that book.
  return Object.entries(card.addressBookIds ?? {}).some(
    ([id, present]) => present === true && books[id]?.myRights.mayWrite === true,
  );
}

/**
 * Whether the card can be deleted: at least one of the address books it belongs to grants
 * `mayDelete`. The single gate the delete affordance uses (branch 5), so a card in only
 * non-deletable books shows no delete UI rather than letting the user hit a server refusal.
 * Mirrors {@link cardMayWrite} exactly — same "any book grants it" + membership-value-`=== true`
 * shape — but on `myRights.mayDelete`. Reactive callers pass the live `addressBooks` store.
 */
export function cardMayDelete(card: ContactCard, books: Record<string, AddressBook>): boolean {
  return Object.entries(card.addressBookIds ?? {}).some(
    ([id, present]) => present === true && books[id]?.myRights.mayDelete === true,
  );
}

// ---------------------------------------------------------------------------
// Editable contact model — the form's working copy of a card, and the pure
// transforms that turn it back into (a) a full card for an optimistic store
// write and (b) a minimal JSON-pointer patch for ContactCard/set update.
// ---------------------------------------------------------------------------

/**
 * One editable entry of a single-value JSContact map (emails/phones/addresses/…). `key` is the
 * card's original server-assigned map key, or `null` for an entry the user just added: keeping it
 * lets a rebuild patch the entry IN PLACE — preserving the original sub-object's un-edited fields
 * (`pref`, `contexts`, address `components`, …) and avoiding a needless re-key — while a new entry
 * gets a fresh key. `value` is the one leaf the form edits (the address / number / name / note / …).
 */
export interface ValueEntry {
  key: string | null;
  value: string;
}

/** An editable {@link CardOnlineService} entry: a label plus a user handle and/or a URI. */
export interface ServiceEntry {
  key: string | null;
  service: string;
  user: string;
  uri: string;
}

/**
 * The form's working copy of a card: every rendered property as a flat, editable shape. Postal
 * `addresses` edit only their `full` one-line string here (a component-only address shows empty and
 * its components are preserved untouched — see {@link cardToEditable}); the structured component
 * editor is a later refinement.
 */
export interface EditableContact {
  nameFull: string;
  nicknames: ValueEntry[];
  emails: ValueEntry[];
  phones: ValueEntry[];
  addresses: ValueEntry[];
  organizations: ValueEntry[];
  titles: ValueEntry[];
  notes: ValueEntry[];
  onlineServices: ServiceEntry[];
}

/** Derive the form's working copy from a card. Map keys are preserved (see {@link ValueEntry}). */
export function cardToEditable(card: ContactCard): EditableContact {
  const single = <T>(
    map: Record<string, T> | undefined,
    leaf: (v: T) => string | undefined,
  ): ValueEntry[] => Object.entries(map ?? {}).map(([key, v]) => ({ key, value: leaf(v) ?? "" }));
  return {
    nameFull: card.name?.full ?? "",
    nicknames: single(card.nicknames, (v) => v?.name),
    emails: single(card.emails, (v) => v?.address),
    phones: single(card.phones, (v) => v?.number),
    // Only `full` is editable; a component-only address shows empty and keeps its components.
    addresses: single(card.addresses, (v) => v?.full),
    organizations: single(card.organizations, (v) => v?.name),
    titles: single(card.titles, (v) => v?.name),
    notes: single(card.notes, (v) => v?.note),
    onlineServices: Object.entries(card.onlineServices ?? {}).map(([key, v]) => ({
      key,
      service: v?.service ?? "",
      user: v?.user ?? "",
      uri: v?.uri ?? "",
    })),
  };
}

// An empty/blank edit becomes "no entry"; a missing map becomes the property's removal. Set a
// non-empty value, delete an emptied one (so a cleared field drops the carried-through leaf too).
function setOrDelete(obj: Record<string, unknown>, key: string, value: string): void {
  if (value) obj[key] = value;
  else delete obj[key];
}

// A key not already in `used`, recorded so successive new entries in one rebuild don't collide.
function freshKey(used: Set<string>): string {
  let i = 0;
  while (used.has(`c${i}`)) i += 1;
  const key = `c${i}`;
  used.add(key);
  return key;
}

// Rebuild a single-value map from its editable entries, patching each entry IN PLACE onto its
// original sub-object (carrying through fields the form doesn't edit — `pref`/`contexts`, a postal
// address's `components`, an org's `units`) under its original key; new entries get a fresh key.
//
// An entry whose value still equals the card's original leaf is kept VERBATIM — never trimmed,
// re-keyed, or diffed — so opening and saving without touching it is a true no-op (no whitespace
// stripping, no spurious patch). Only a value the user actually changed is trimmed.
//
// A (changed) blank value means "this leaf is empty", NOT "delete the entry" (removal is the ✕
// button, which drops the row from `entries`). So clearing an EXISTING entry's leaf keeps the rest —
// this is what preserves a component-only address whose `full` is blank. The entry is dropped only
// when nothing survives: a NEW entry with a blank value, or an existing entry whose sub-object is
// empty once the leaf is removed. Returns undefined when no entry survives → the property's removal.
function rebuildSingle<T extends object>(
  entries: ValueEntry[],
  original: Record<string, T> | undefined,
  leaf: string,
): Record<string, T> | undefined {
  const out: Record<string, T> = {};
  const used = new Set(entries.map((e) => e.key).filter((k): k is string => k !== null));
  for (const entry of entries) {
    const base = entry.key ? original?.[entry.key] : undefined;
    const originalLeaf = base ? (base as Record<string, unknown>)[leaf] : undefined;
    // Unchanged (the editable value still matches the original leaf, both treating absent as "") →
    // keep the server's sub-object verbatim. cardToEditable does not trim, so this round-trips.
    if (base && entry.value === (originalLeaf ?? "")) {
      out[entry.key as string] = base;
      continue;
    }
    const value = entry.value.trim();
    if (value === "") {
      if (!base) continue; // a new (or already-empty) entry with nothing to keep
      const kept = { ...base } as Record<string, unknown>;
      delete kept[leaf];
      if (Object.keys(kept).length === 0) continue; // the leaf was its only field — drop it
      out[entry.key as string] = kept as T;
    } else {
      out[entry.key ?? freshKey(used)] = { ...(base ?? {}), [leaf]: value } as T;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function rebuildServices(
  entries: ServiceEntry[],
  original: Record<string, CardOnlineService> | undefined,
): Record<string, CardOnlineService> | undefined {
  const out: Record<string, CardOnlineService> = {};
  const used = new Set(entries.map((e) => e.key).filter((k): k is string => k !== null));
  for (const entry of entries) {
    const base = entry.key ? original?.[entry.key] : undefined;
    // Unchanged → keep verbatim (preserves contexts, never drops an existing entry, no trim churn).
    if (
      base &&
      entry.service === (base.service ?? "") &&
      entry.user === (base.user ?? "") &&
      entry.uri === (base.uri ?? "")
    ) {
      out[entry.key as string] = base;
      continue;
    }
    const service = entry.service.trim();
    const user = entry.user.trim();
    const uri = entry.uri.trim();
    // A new or edited entry left with neither a handle nor a URI isn't a usable service — drop it.
    // (An existing such entry is caught by the unchanged guard above, so it's never silently deleted.)
    if (user === "" && uri === "") continue;
    const obj: Record<string, unknown> = { ...(base ?? {}) };
    setOrDelete(obj, "service", service);
    setOrDelete(obj, "user", user);
    setOrDelete(obj, "uri", uri);
    out[entry.key ?? freshKey(used)] = obj as CardOnlineService;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Rebuild the name: keep the original components/isOrdered, set/clear `full`. Unchanged `full`
// (matching the original, absent treated as "") keeps the original name verbatim — no trim churn.
// An emptied name object (no full, no components) becomes undefined → the property's removal.
function rebuildName(nameFull: string, original: CardName | undefined): CardName | undefined {
  if (nameFull === (original?.full ?? "")) return original;
  const next: CardName = { ...(original ?? {}) };
  const full = nameFull.trim();
  if (full) next.full = full;
  else delete next.full;
  return Object.keys(next).length > 0 ? next : undefined;
}

// The editable properties rebuilt back into their card shapes (undefined = property removed). One
// source of truth so the optimistic card and the patch can't drift.
interface RebuiltProps {
  name: CardName | undefined;
  nicknames: Record<string, { name: string }> | undefined;
  emails: Record<string, CardEmail> | undefined;
  phones: Record<string, CardPhone> | undefined;
  addresses: Record<string, CardAddress> | undefined;
  organizations: Record<string, CardOrganization> | undefined;
  titles: Record<string, CardTitle> | undefined;
  notes: Record<string, CardNote> | undefined;
  onlineServices: Record<string, CardOnlineService> | undefined;
}

function rebuild(card: ContactCard, e: EditableContact): RebuiltProps {
  return {
    name: rebuildName(e.nameFull, card.name),
    nicknames: rebuildSingle(e.nicknames, card.nicknames, "name"),
    emails: rebuildSingle(e.emails, card.emails, "address"),
    phones: rebuildSingle(e.phones, card.phones, "number"),
    addresses: rebuildSingle(e.addresses, card.addresses, "full"),
    organizations: rebuildSingle(e.organizations, card.organizations, "name"),
    titles: rebuildSingle(e.titles, card.titles, "name"),
    notes: rebuildSingle(e.notes, card.notes, "note"),
    onlineServices: rebuildServices(e.onlineServices, card.onlineServices),
  };
}

/**
 * Apply the form's working copy onto the card, producing the full card for an OPTIMISTIC store
 * write. Properties the form doesn't expose (photos, kind, addressBookIds, version, …) are carried
 * through untouched; an emptied editable property is removed.
 */
export function editableToCard(card: ContactCard, e: EditableContact): ContactCard {
  const next = { ...card };
  const view = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(rebuild(card, e))) {
    if (value === undefined) delete view[key];
    else view[key] = value;
  }
  return next;
}

/**
 * Build the MINIMAL `ContactCard/set update` patch from the form's working copy: a whole-property
 * JSON pointer per editable property that actually changed (deep-compared against the original),
 * set to its rebuilt value or `null` to remove it. Unchanged properties — and every property the
 * form doesn't expose — are absent, so the patch never rewrites or clobbers them. An all-unchanged
 * edit yields `{}` (the store action treats that as a no-op).
 */
export function editableToPatch(card: ContactCard, e: EditableContact): ContactCardPatch {
  const patch: ContactCardPatch = {};
  const original = card as unknown as Record<string, unknown>;
  for (const [key, rebuilt] of Object.entries(rebuild(card, e))) {
    // Stable deep compare: rebuildSingle preserves the original keys + sub-field order for unchanged
    // entries, so an untouched property serializes identically and stays out of the patch.
    if (JSON.stringify(original[key] ?? null) === JSON.stringify(rebuilt ?? null)) continue;
    patch[key] = rebuilt ?? null;
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Create — a blank working copy, plus the transform that turns the form into a
// `ContactCard/set create` body (branch 4). A create has no original card to
// carry leaves through, so every entry is "new": rebuildSingle drops blanks and
// assigns fresh keys (the same drop-blanks invariant the edit path obeys).
// ---------------------------------------------------------------------------

// An empty card, the rebuild "original" for a create: it has none of the maps, so rebuildSingle sees
// no original sub-objects and treats every form entry as new. `{}` typed as ContactCard reads only
// the (all-undefined) optional maps here — a deliberate, contained cast.
const EMPTY_CARD = {} as ContactCard;

/** A blank working copy for the create form — every field empty. The {@link editableHasContent}
 * gate keeps a totally-empty one from being saved, so an actual create always carries something. */
export function emptyEditableContact(): EditableContact {
  return {
    nameFull: "",
    nicknames: [],
    emails: [],
    phones: [],
    addresses: [],
    organizations: [],
    titles: [],
    notes: [],
    onlineServices: [],
  };
}

/**
 * Whether the working copy carries at least one savable property once blanks are dropped (the same
 * rebuild the create/patch transforms run). The create form gates Save on this — an empty form, or
 * one holding only whitespace, isn't a contact worth creating — and {@link createContactBody}'s
 * caller treats a contentless body as a no-op. Mirrors the edit path's "empty patch = no-op".
 */
export function editableHasContent(e: EditableContact): boolean {
  return Object.values(rebuild(EMPTY_CARD, e)).some((v) => v !== undefined);
}

/**
 * Build the `ContactCard/set create` body from the form's working copy: the structural JSContact
 * fields (`@type`, `version`, the chosen `addressBookIds`) plus every editable property that
 * survives the rebuild (blanks dropped, fresh keys assigned). No `id` — the server assigns it and
 * re-keys the creation id (mirrors the Email create path). Properties the form doesn't expose are
 * simply absent (a fresh card has no photos/kind/etc.).
 */
export function createContactBody(
  e: EditableContact,
  addressBookIds: Record<string, true>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { "@type": "Card", version: "1.0", addressBookIds };
  for (const [key, value] of Object.entries(rebuild(EMPTY_CARD, e))) {
    if (value !== undefined) body[key] = value;
  }
  return body;
}

/**
 * Seed a full local {@link ContactCard} for the optimistic store write after a create: the structural
 * fields under the server-assigned `id` + book membership, with the form's edits overlaid. Reconciled
 * to server truth straight after (absorbing any normalization), but gives the new contact an instant
 * render. Same rebuild as {@link createContactBody}, so the two can't drift.
 */
export function createdCardFor(
  id: string,
  e: EditableContact,
  addressBookIds: Record<string, true>,
): ContactCard {
  const seed = { "@type": "Card", version: "1.0", id, addressBookIds } as unknown as ContactCard;
  return editableToCard(seed, e);
}

/** The address books this account can write a new card into (`myRights.mayWrite`), sorted for the
 * picker. The "+ New contact" affordance is gated on this being non-empty; the create form's book
 * picker lists them (and skips the picker when there's exactly one). */
export function writableBooks(books: Record<string, AddressBook>): AddressBook[] {
  return Object.values(books)
    .filter((b) => b.myRights.mayWrite === true)
    .sort(compareAddressBooks);
}

/** The default destination among writable `books` (already filtered/sorted by {@link writableBooks}):
 * the server-default book if it's writable, else the first. Null only when there are none. */
export function defaultWritableBookId(books: AddressBook[]): string | null {
  return (books.find((b) => b.isDefault) ?? books[0])?.id ?? null;
}
