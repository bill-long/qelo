import { subscribeToChanges } from "@/jmap/push";
import { jmap, session } from "./account";
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
    if ("Email" in changed || "Thread" in changed) void syncMail();
    if ("Mailbox" in changed) void loadMailboxes();
  });
}

export function stopSync(): void {
  unsubscribe?.();
  unsubscribe = null;
}
