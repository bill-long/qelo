import { subscribeToChanges } from "@/jmap/push";
import { handleAuthFailure, jmap, session } from "./account";
import { syncEmails, syncThreadList } from "./emails";
import { loadMailboxes } from "./mailboxes";

let unsubscribe: (() => void) | null = null;

// Push events can arrive in bursts, and the Email/Thread sync mutates a shared cursor
// (emailState in emails.ts) plus the stores. Serialize it so only one run is in flight,
// and coalesce events that arrive mid-run into a single follow-up pass instead of
// spawning overlapping runs that redo work and race on the cursor.
let mailSyncing = false;
let mailSyncQueued = false;

async function syncMail(): Promise<void> {
  if (mailSyncing) {
    mailSyncQueued = true;
    return;
  }
  mailSyncing = true;
  try {
    do {
      mailSyncQueued = false;
      await syncThreadList();
      await syncEmails();
    } while (mailSyncQueued);
  } finally {
    mailSyncing = false;
  }
}

/**
 * Run a fire-and-forget sync action. A 401 whose refresh failed flips the gate to re-auth
 * (handleAuthFailure also stops sync); any other failure is logged and ignored (a later
 * push or folder switch will resync).
 */
function runSync(action: () => Promise<void>): void {
  void action().catch((err) => {
    if (handleAuthFailure(err)) return;
    console.error("Background sync failed:", err);
  });
}

/**
 * Start listening for server-pushed changes and route them to the stores: Email/Thread
 * changes patch the open conversation list (and refresh shown emails); Mailbox changes
 * reload the folder list (unread counts). Safe to call repeatedly — it resubscribes.
 */
export function startSync(): void {
  stopSync();
  const current = session();
  if (!current) return;
  const accountId = jmap().accountId;
  unsubscribe = subscribeToChanges(current, ["Mailbox", "Email", "Thread"], (account, changed) => {
    if (account !== accountId) return;
    if ("Email" in changed || "Thread" in changed) runSync(syncMail);
    if ("Mailbox" in changed) runSync(loadMailboxes);
  });
}

export function stopSync(): void {
  unsubscribe?.();
  unsubscribe = null;
}
