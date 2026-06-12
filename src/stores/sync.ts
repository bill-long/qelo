import { createSignal } from "solid-js";
import { type PushStatus, subscribeToChanges } from "@/jmap/push";
import { handleAuthFailure, jmap, session } from "./account";
import { syncEmails, syncThreadList } from "./emails";
import { syncMailboxes } from "./mailboxes";

let unsubscribe: (() => void) | null = null;

/**
 * State of the live push channel (EventSource): `connecting` until the first open,
 * `live` while delivering changes, `reconnecting` while retrying a dropped stream.
 * Surfaced in the UI so a persistent failure (bad push auth, proxy down) is visible
 * instead of silently leaving live updates dead. `null` when sync isn't running.
 */
export const [pushStatus, setPushStatus] = createSignal<PushStatus | null>(null);

// Push events can arrive in bursts, and the sync actions mutate shared cursors (emailState,
// mailboxState) plus the stores. Wrap each in a serializer so only one run is in flight: a
// call made mid-run is coalesced into a single follow-up pass instead of spawning an
// overlapping run that redoes work and races on the cursor.
function coalesce(run: () => Promise<void>): () => Promise<void> {
  let running = false;
  let queued = false;
  return async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      do {
        queued = false;
        await run();
      } while (queued);
    } finally {
      running = false;
    }
  };
}

// Email and Mailbox sync own independent cursors, so they serialize independently (a
// mail burst shouldn't block a folder-count refresh) but each is single-flight.
const syncMail = coalesce(async () => {
  await syncThreadList();
  await syncEmails();
});
const syncFolders = coalesce(syncMailboxes);

/**
 * Run a fire-and-forget sync action. A {@link JmapAuthError} (token refresh impossible, or
 * the retry still 401s) flips the gate to re-auth — handleAuthFailure also stops sync. Any
 * other failure, including a refresh that *threw* (transient keychain/network error), is
 * logged and ignored; a later push or folder switch will resync.
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
 * patch the folder list incrementally. The channel's connection state is mirrored into
 * {@link pushStatus}, and a reconnect triggers a full resync (changes pushed while the
 * stream was down were missed). Safe to call repeatedly — it resubscribes.
 */
export function startSync(): void {
  stopSync();
  const current = session();
  if (!current) return;
  const accountId = jmap().accountId;
  setPushStatus("connecting");
  unsubscribe = subscribeToChanges(current, ["Mailbox", "Email", "Thread"], {
    onChange: (account, changed) => {
      if (account !== accountId) return;
      if ("Email" in changed || "Thread" in changed) runSync(syncMail);
      if ("Mailbox" in changed) runSync(syncFolders);
    },
    onStatus: setPushStatus,
    onReopen: () => {
      // We were disconnected and may have missed change notifications — resync both the
      // mail view and the folder list to catch up.
      runSync(syncMail);
      runSync(syncFolders);
    },
  });
}

export function stopSync(): void {
  unsubscribe?.();
  unsubscribe = null;
  setPushStatus(null);
}
