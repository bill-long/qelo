import { subscribeToChanges } from "@/jmap/push";
import { jmap, session } from "./account";
import { syncEmails, syncThreadList } from "./emails";
import { loadMailboxes } from "./mailboxes";

let unsubscribe: (() => void) | null = null;

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
    if ("Email" in changed || "Thread" in changed) {
      void syncThreadList();
      void syncEmails();
    }
    if ("Mailbox" in changed) void loadMailboxes();
  });
}

export function stopSync(): void {
  unsubscribe?.();
  unsubscribe = null;
}
