// Recipient autocomplete state. Two sources feed one ranked index:
//   1. Past recipients mined from sent mail — a cursor-free Email/query over the Sent mailbox + an
//      Email/get for the recipients of those messages. One batched round trip, mined once per session
//      (lazily, on composer open). We do NOT advance any sync cursor from this partial fetch — the
//      push-driven drain owns emailState (same discipline as conversationEmailIds / reconcileRefused).
//   2. The user's saved contacts — read straight from the reactive `contactCards` store (stores/
//      contacts.ts), which loadContacts() populates once and syncContacts keeps current. We reuse
//      that canonical load (kicked on composer open below) rather than a private partial fetch, so we
//      never advance a contacts cursor here either.
// `lib/recipients.ts` merges both into a recency+frequency ranked index (contacts as a known-good
// floor). The index is a memo so it rebuilds only when a source changes — and folds in contacts that
// load/sync AFTER the Sent mine. No local persistence yet: Sent's EmailAddress objects already carry
// display names, recency falls out of the newest-first query, and a persistent recency/frequency
// store (Rust cache or IndexedDB) is its own review surface deferred to a later phase.

import { createMemo, createRoot, createSignal } from "solid-js";
import { emailGet, emailQuery, idsFromQuery, methodResult } from "@/jmap/methods";
import type { Email } from "@/jmap/types";
import { buildSuggestionIndex, matchRecipients, type RecipientSuggestion } from "@/lib/recipients";
import { handleAuthFailure, jmap } from "./account";
import { contactCards, loadContacts } from "./contacts";
import { mailboxIdByRole } from "./mailboxes";

// How many recent Sent messages to mine. Enough to cover the addresses worth completing without a
// heavy payload; newest-first, so frequent/recent contacts are well within the window.
const SENT_SCAN_LIMIT = 200;

// Only the recipient fields are needed to derive suggestions (Sent → `from` is the user). A tight
// property set keeps the Email/get small.
const RECIPIENT_PROPERTIES = ["id", "to", "cc", "bcc"] as const;

// The raw newest-first Sent emails from the last successful mine. The suggestion index derives from
// these PLUS the reactive contacts store, so it recomputes when either source arrives or changes.
const [sentEmails, setSentEmails] = createSignal<Email[]>([]);

/**
 * The merged ranked suggestion index (Sent-mined + saved contacts). A memo so it rebuilds only when a
 * source changes — not per keystroke — and so contacts that load/sync after the Sent mine still fold
 * in. createRoot owns the computation for the app's lifetime (a module singleton, intentionally never
 * disposed), the idiomatic home for app-wide derived state outside a component tree.
 */
export const suggestionIndex = createRoot(() => {
  const index = createMemo<RecipientSuggestion[]>(() =>
    buildSuggestionIndex(sentEmails(), Object.values(contactCards)),
  );
  return index;
});

// Load-once guard: "idle" until a load is attempted, "loading" while in flight, "loaded" after a
// successful build. A failed load returns to "idle" so the next composer open retries (a transient
// blip shouldn't permanently disable autocomplete). Like the identities load, this runs once per
// session — but the guard lives here (the caller just fires it), not at the call site.
let loadState: "idle" | "loading" | "loaded" = "idle";

/**
 * Prime both autocomplete sources: kick a contacts load, then mine the Sent mailbox for past
 * recipients — once per session each. The merged index (the `suggestionIndex` memo) updates
 * reactively as either source lands. The Sent mine is a no-op while in flight or already done, and
 * when the account exposes no Sent mailbox (nothing to mine). Cursor-free: the Email/get is a partial
 * fetch that does NOT advance emailState (and the contacts load owns its own cursors). Fire-and-forget
 * from the composer; resolves (never rejects) — a transport failure leaves the Sent source empty and
 * resets the guard so a later open retries; an auth failure raises the global re-auth gate.
 */
export async function loadRecipientSuggestions(): Promise<void> {
  // Kick the second source (saved contacts): a load-once that's idempotent, never rejects, and a
  // no-op on a contacts-less account. The merged index memo folds them in reactively when they
  // arrive — loadContacts owns the contacts cursors, so this advances nothing here. Fired before the
  // Sent-mine guard so contacts still load even when Sent was already mined (or has no folder).
  void loadContacts();
  if (loadState !== "idle") return;
  const sentId = mailboxIdByRole("sent");
  if (!sentId) return; // no Sent folder → no past recipients to mine; retry if one appears later
  loadState = "loading";
  try {
    const client = jmap();
    const responses = await client.request([
      emailQuery(client.accountId, "q", {
        mailboxId: sentId,
        // Explicitly off (not relying on the JMAP default): we want every sent message's recipients,
        // not one representative per conversation.
        collapseThreads: false,
        limit: SENT_SCAN_LIMIT,
      }),
      emailGet(client.accountId, "g", {
        idsRef: idsFromQuery("q"),
        properties: RECIPIENT_PROPERTIES,
      }),
    ]);
    // Reorder the fetched emails to the Email/query order (newest-first): Email/get does NOT
    // guarantee it returns records in the requested-id order, and buildSuggestionIndex's recency
    // ranking depends on newest-first input. Drop any id the /get didn't return.
    const queryIds = (methodResult(responses, "q").ids ?? []) as string[];
    const byId = new Map(
      ((methodResult(responses, "g").list ?? []) as Email[]).map((e) => [e.id, e]),
    );
    const ordered = queryIds.map((id) => byId.get(id)).filter((e): e is Email => e !== undefined);
    setSentEmails(ordered);
    loadState = "loaded";
  } catch (err) {
    loadState = "idle"; // allow a retry on the next composer open
    handleAuthFailure(err); // raise the re-auth gate on an auth failure; otherwise swallow (no UI)
  }
}

/**
 * The suggestions matching `query`, excluding addresses already entered. Thin reactive selector over
 * the loaded index (reads the signal so callers re-run when it loads). `exclude` is the set of
 * lowercased emails already in the field, so a recipient isn't offered twice.
 */
export function recipientSuggestions(
  query: string,
  exclude?: ReadonlySet<string>,
): RecipientSuggestion[] {
  return matchRecipients(suggestionIndex(), query, 6, exclude);
}

/**
 * Reset the Sent-mined recipient state — a test seam (the load is otherwise once-per-session). Only
 * the Sent source; the contacts source clears via resetContacts (the harness calls both), and the
 * suggestion index memo derives from both, so it empties once each source is reset.
 */
export function resetRecipients(): void {
  setSentEmails([]);
  loadState = "idle";
}
