import { onMount, Show } from "solid-js";
import { Composer } from "@/components/composer/Composer";
import { SyncStatus } from "@/components/layout/SyncStatus";
import { MailboxList } from "@/components/mailbox/MailboxList";
import { ThreadList } from "@/components/thread-list/ThreadList";
import { ThreadView } from "@/components/thread-view/ThreadView";
import { composeOpen, loadIdentities, openComposer } from "@/stores/compose";

/** The three-pane mail layout: folders | conversation list | reading pane. */
export function Shell() {
  // Load the sending identities up front (Shell mounts only once connected) so a reply-all can
  // exclude the user's own addresses from Cc on the very FIRST reply — otherwise identities() is
  // empty until the first composer open and the self-exclusion silently no-ops. loadIdentities is
  // idempotent, doesn't block render (fire-and-forget), and surfaces any error into the composer.
  onMount(() => void loadIdentities());

  return (
    <div class="shell">
      {/* The folder sidebar is an <aside>; MailboxList provides the inner <nav>
          landmark, so nesting two navigation regions is avoided. */}
      <aside class="shell-folders">
        <div class="brand">Qelo</div>
        <button type="button" class="compose-button" onClick={() => openComposer()}>
          <span aria-hidden="true">✎</span> Compose
        </button>
        <MailboxList />
        <SyncStatus />
      </aside>
      <section class="shell-threads">
        <ThreadList />
      </section>
      <section class="shell-view">
        <ThreadView />
      </section>
      <Show when={composeOpen()}>
        <Composer />
      </Show>
    </div>
  );
}
