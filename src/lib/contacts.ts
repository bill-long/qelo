// Pure helpers for the read-only contacts view: derive a display name and a primary/ordered
// email from a JSContact Card, and a stable sort comparator for the list. No SolidJS, no JMAP
// client — data → data, unit-tested in isolation. Reused by the recipient-autocomplete contacts
// source (branch 2), so the display-name + primary-email logic lives here, not in a component.
//
// JSContact (RFC 9553) leaves almost everything optional and stores sub-objects in id-keyed maps
// whose keys are server-assigned (not meaningful) — so we iterate values in insertion order, never
// keys, and guard every access (noUncheckedIndexedAccess makes map reads `T | undefined`).

import type { AddressBook, CardEmail, ContactCard } from "@/jmap/types";

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
