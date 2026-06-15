// Recipient autocomplete state (Phase 1: past recipients mined from sent mail).
//
// Source = a cursor-free Email/query over the Sent mailbox + an Email/get for the recipients of those
// messages, from which `lib/recipients.ts` builds a recency+frequency ranked index. One batched round
// trip, loaded once per session (lazily, on composer open). We do NOT advance any sync cursor from
// this partial fetch — the push-driven drain owns emailState (same discipline as conversationEmailIds
// / reconcileRefused). No local persistence in Phase 1: Sent's EmailAddress objects already carry
// display names, recency falls out of the newest-first query, and a persistent recency/frequency
// store (Rust cache or IndexedDB) is its own review surface deferred to a later phase. Contacts arrive
// with the JMAP Contacts milestone and layer in as a second source.

import { createSignal } from "solid-js";
import { emailGet, emailQuery, idsFromQuery, methodResult } from "@/jmap/methods";
import type { Email } from "@/jmap/types";
import { buildSuggestionIndex, matchRecipients, type RecipientSuggestion } from "@/lib/recipients";
import { handleAuthFailure, jmap } from "./account";
import { mailboxIdByRole } from "./mailboxes";

// How many recent Sent messages to mine. Enough to cover the addresses worth completing without a
// heavy payload; newest-first, so frequent/recent contacts are well within the window.
const SENT_SCAN_LIMIT = 200;

// Only the recipient fields are needed to derive suggestions (Sent → `from` is the user). A tight
// property set keeps the Email/get small.
const RECIPIENT_PROPERTIES = ["id", "to", "cc", "bcc"] as const;

export const [suggestionIndex, setSuggestionIndex] = createSignal<RecipientSuggestion[]>([]);

// Load-once guard: "idle" until a load is attempted, "loading" while in flight, "loaded" after a
// successful build. A failed load returns to "idle" so the next composer open retries (a transient
// blip shouldn't permanently disable autocomplete). Like the identities load, this runs once per
// session — but the guard lives here (the caller just fires it), not at the call site.
let loadState: "idle" | "loading" | "loaded" = "idle";

/**
 * Mine the Sent mailbox for past recipients and build the suggestion index — once per session. A
 * no-op while a load is in flight or already done, and when the account exposes no Sent mailbox
 * (nothing to mine — leaves the index empty). Cursor-free: the Email/get is a partial fetch that does
 * NOT advance emailState. Fire-and-forget from the composer; resolves (never rejects) — a transport
 * failure leaves the index empty and resets the guard so a later open retries; an auth failure raises
 * the global re-auth gate.
 */
export async function loadRecipientSuggestions(): Promise<void> {
  if (loadState !== "idle") return;
  const sentId = mailboxIdByRole("sent");
  if (!sentId) return; // no Sent folder → no past recipients to mine; retry if one appears later
  loadState = "loading";
  try {
    const client = jmap();
    const responses = await client.request([
      emailQuery(client.accountId, "q", {
        mailboxId: sentId,
        // collapseThreads off: we want every sent message's recipients, not one per conversation.
        limit: SENT_SCAN_LIMIT,
      }),
      emailGet(client.accountId, "g", {
        idsRef: idsFromQuery("q"),
        properties: RECIPIENT_PROPERTIES,
      }),
    ]);
    const list = (methodResult(responses, "g").list ?? []) as Email[];
    setSuggestionIndex(buildSuggestionIndex(list));
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

/** Reset all recipient-suggestion state — a test seam (the load is otherwise once-per-session). */
export function resetRecipients(): void {
  setSuggestionIndex([]);
  loadState = "idle";
}
