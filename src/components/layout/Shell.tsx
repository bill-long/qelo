import { onMount, Show } from "solid-js";
import { Composer } from "@/components/composer/Composer";
import { AddressBookList } from "@/components/contacts/AddressBookList";
import { ContactList } from "@/components/contacts/ContactList";
import { ContactView } from "@/components/contacts/ContactView";
import { SyncStatus } from "@/components/layout/SyncStatus";
import { ToastHost } from "@/components/layout/ToastHost";
import { ViewSwitch } from "@/components/layout/ViewSwitch";
import { MailboxList } from "@/components/mailbox/MailboxList";
import { ThreadList } from "@/components/thread-list/ThreadList";
import { ThreadView } from "@/components/thread-view/ThreadView";
import { composeOpen, loadIdentities, openComposer } from "@/stores/compose";
import { activeView } from "@/stores/ui";

/**
 * The app shell: a top-level Mail / Contacts / Calendar switch over the three-pane layout. Mail
 * shows folders | conversations | reading pane; Contacts swaps in address books | contact list |
 * contact detail across the same grid columns. The Composer + ToastHost stay mounted across views.
 */
export function Shell() {
  // Load the sending identities up front (Shell mounts only once connected) so a reply-all can
  // exclude the user's own addresses from Cc on the very FIRST reply — otherwise identities() is
  // empty until the first composer open and the self-exclusion silently no-ops. loadIdentities is
  // idempotent, doesn't block render (fire-and-forget), and surfaces any error into the composer.
  onMount(() => void loadIdentities());

  const isMail = () => activeView() === "mail";

  return (
    <div class="shell">
      {/* The sidebar is an <aside>; ViewSwitch and the inner list each provide their own <nav>
          landmark. The switch replaces the old static brand label. */}
      <aside class="shell-folders">
        <ViewSwitch />
        <Show when={isMail()} fallback={<AddressBookList />}>
          <button type="button" class="compose-button" onClick={() => openComposer()}>
            <span aria-hidden="true">✎</span> Compose
          </button>
          <MailboxList />
        </Show>
        <SyncStatus />
      </aside>
      <Show
        when={isMail()}
        fallback={
          <>
            <section class="shell-threads">
              <ContactList />
            </section>
            <section class="shell-view">
              <ContactView />
            </section>
          </>
        }
      >
        <section class="shell-threads">
          <ThreadList />
        </section>
        <section class="shell-view">
          <ThreadView />
        </section>
      </Show>
      <Show when={composeOpen()}>
        <Composer />
      </Show>
      <ToastHost />
    </div>
  );
}
