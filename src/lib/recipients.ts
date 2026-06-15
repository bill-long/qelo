// Pure helpers for recipient autocomplete (Phase 1: past recipients mined from sent mail).
//
// Two concerns, both string/data → string/data so they're unit-tested in isolation (no SolidJS,
// no JMAP client):
//   1. Build a ranked suggestion index from the recipients of sent Email objects, and match a typed
//      fragment against it.
//   2. Locate and replace the address fragment the caret sits in within a multi-recipient field, so
//      picking a suggestion completes only the address being typed and leaves the rest untouched.
//
// A picked suggestion is inserted as a BARE address (no `Name <addr>` form): `lib/addresses.ts`
// `parseRecipients` splits on whitespace and validates each token as a bare address, so inserting a
// display-name form would break parsing/validation. The dropdown shows the rich "Name <email>"
// label; only `email` is written into the field — and the store's send-time validator still vets it.

import type { Email, EmailAddress } from "@/jmap/types";

/** One address the user can complete to: the bare `email`, plus a display `name` when one is known. */
export interface RecipientSuggestion {
  email: string;
  name: string | null;
}

// Internal accumulator: a suggestion plus the signals it's ranked by.
interface Ranked extends RecipientSuggestion {
  /** How many sent messages addressed this email (frequency). */
  count: number;
  /** Encounter order of the FIRST sighting — lower = more recent (the input is newest-first). */
  rank: number;
}

/**
 * Build a ranked suggestion index from sent messages' recipients. `emails` MUST be newest-first
 * (the order the Sent `Email/query` returns), so encounter order doubles as a recency signal.
 * Collects every `to`/`cc`/`bcc` address, dedupes by the LOWERCASED email (a content key, like the
 * blob-dedupe elsewhere — `bcc`/`cc` casing varies), keeps the verbatim address of the first sighting
 * for display, fills in a display name from a later sighting if the first lacked one, and counts
 * occurrences. Result is sorted most-frequent-first, ties broken by most-recent — the order the
 * combobox surfaces matches.
 */
export function buildSuggestionIndex(emails: Email[]): RecipientSuggestion[] {
  // A Map (not a plain object) so an exotic local part like "__proto__@x" is just an ordinary key.
  const byEmail = new Map<string, Ranked>();
  let order = 0;
  for (const email of emails) {
    const recipients: EmailAddress[] = [
      ...(email.to ?? []),
      ...(email.cc ?? []),
      ...(email.bcc ?? []),
    ];
    for (const addr of recipients) {
      const raw = addr.email?.trim();
      if (!raw) continue; // a group/undisclosed entry can lack an address
      const key = raw.toLowerCase();
      const name = addr.name?.trim() || null;
      const existing = byEmail.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.name && name) existing.name = name; // backfill a name the first sighting lacked
      } else {
        byEmail.set(key, { email: raw, name, count: 1, rank: order });
        order += 1;
      }
    }
  }
  return [...byEmail.values()]
    .sort((a, b) => b.count - a.count || a.rank - b.rank)
    .map(({ email, name }) => ({ email, name }));
}

/**
 * The suggestions matching `query`, best-first (the index is pre-ranked). Matches a case-insensitive
 * substring of either the email or the display name. An empty/whitespace `query` yields nothing (we
 * don't surface the whole address book on an empty fragment). `exclude` (lowercased emails already in
 * the field) drops addresses the user has already entered, and an exact-match-to-the-query address is
 * skipped — there's nothing left to complete once it's fully typed.
 */
export function matchRecipients(
  index: readonly RecipientSuggestion[],
  query: string,
  limit = 6,
  exclude: ReadonlySet<string> = new Set(),
): RecipientSuggestion[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const out: RecipientSuggestion[] = [];
  for (const s of index) {
    const emailLc = s.email.toLowerCase();
    if (exclude.has(emailLc) || emailLc === q) continue;
    const nameLc = s.name?.toLowerCase() ?? "";
    if (emailLc.includes(q) || nameLc.includes(q)) {
      out.push(s);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// A recipient separator: comma, semicolon, OR whitespace — the SAME set `lib/addresses.ts`
// `splitRecipients` tokenizes on. Keeping the fragment boundary identical to the parser's is what
// lets autocomplete isolate the address being edited even when the user separates with spaces (which
// `parseRecipients` accepts) — a comma/semicolon-only boundary would treat `a@x.io b@x.io` as one
// fragment and match nothing.
const SEPARATOR = /[\s,;]/;

/**
 * The address fragment the caret sits in within a multi-recipient field, bounded by the surrounding
 * separators (or the field edges), with its `[start, end)` offsets in `value`. A recipient field is a
 * separator-joined list, so this isolates just the address being edited — whichever one the caret is
 * in, not only the trailing one — for matching and replacement. `text` is the fragment (separators
 * can't appear inside it, so no trim needed); `start`/`end` bound the raw slice to replace.
 */
export function activeFragment(
  value: string,
  caret: number,
): { start: number; end: number; text: string } {
  const pos = Math.max(0, Math.min(caret, value.length));
  let start = 0;
  for (let i = pos - 1; i >= 0; i -= 1) {
    if (SEPARATOR.test(value[i] as string)) {
      start = i + 1;
      break;
    }
  }
  let end = value.length;
  for (let i = pos; i < value.length; i += 1) {
    if (SEPARATOR.test(value[i] as string)) {
      end = i;
      break;
    }
  }
  return { start, end, text: value.slice(start, end) };
}

/**
 * Replace the caret's address fragment with `email`, leaving a `", "` after it so the next address
 * can be typed immediately, and report where the caret should land (just after that trailing `", "`).
 * Only the active fragment changes — addresses before and after it are preserved. The separators
 * hugging the edit are canonicalized to a single `", "` join (so completing twice can't pile up
 * commas/spaces, and a mixed/space/semicolon style settles to the comma-space the field renders).
 */
export function completeFragment(
  value: string,
  caret: number,
  email: string,
): { value: string; caret: number } {
  const { start, end } = activeFragment(value, caret);
  // Strip the run of separators (commas/semicolons/whitespace) on each side of the fragment so the
  // join is exactly one ", " regardless of what the user typed. `before`/`after` are then the bare
  // neighboring addresses (or "" at the field edges).
  const before = value.slice(0, start).replace(/[\s,;]+$/, "");
  const after = value.slice(end).replace(/^[\s,;]+/, "");
  const head = before ? `${before}, ${email}` : email;
  // Always leave a trailing ", " (the caret lands just past it); when an address follows, it joins on
  // through the same ", " rather than the user's original separator.
  const newValue = `${head}, ${after}`;
  return { value: newValue, caret: head.length + 2 };
}
