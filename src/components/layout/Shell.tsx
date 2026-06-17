import { Match, onMount, Show, Switch } from "solid-js";
import { CalendarList } from "@/components/calendar/CalendarList";
import { EventList } from "@/components/calendar/EventList";
import { EventView } from "@/components/calendar/EventView";
import { Composer } from "@/components/composer/Composer";
import { AddressBookList } from "@/components/contacts/AddressBookList";
import { ContactList } from "@/components/contacts/ContactList";
import { ContactView } from "@/components/contacts/ContactView";
import { NewContactButton } from "@/components/contacts/NewContactButton";
import { SyncStatus } from "@/components/layout/SyncStatus";
import { ToastHost } from "@/components/layout/ToastHost";
import { ViewSwitch } from "@/components/layout/ViewSwitch";
import { MailboxList } from "@/components/mailbox/MailboxList";
import { ThreadList } from "@/components/thread-list/ThreadList";
import { ThreadView } from "@/components/thread-view/ThreadView";
import { composeOpen, loadIdentities, openComposer } from "@/stores/compose";
import { activeView } from "@/stores/ui";

/**
 * The app shell: a top-level Mail / Contacts / Calendar switch over the three-pane layout. Each view
 * swaps a sidebar + two panes across the same grid columns — Mail: folders | conversations | reading
 * pane; Contacts: address books | contact list | contact detail; Calendar: calendars | agenda |
 * event detail. The Composer + ToastHost stay mounted across views.
 */
export function Shell() {
  // Load the sending identities up front (Shell mounts only once connected) so a reply-all can
  // exclude the user's own addresses from Cc on the very FIRST reply — otherwise identities() is
  // empty until the first composer open and the self-exclusion silently no-ops. loadIdentities is
  // idempotent, doesn't block render (fire-and-forget), and surfaces any error into the composer.
  onMount(() => void loadIdentities());

  return (
    <div class="shell">
      {/* The sidebar is an <aside>; ViewSwitch and the inner list each provide their own <nav>
          landmark. The switch replaces the old static brand label. */}
      <aside class="shell-folders">
        <ViewSwitch />
        <Switch>
          <Match when={activeView() === "mail"}>
            <button type="button" class="compose-button" onClick={() => openComposer()}>
              <span aria-hidden="true">✎</span> Compose
            </button>
            <MailboxList />
          </Match>
          <Match when={activeView() === "contacts"}>
            <NewContactButton />
            <AddressBookList />
          </Match>
          <Match when={activeView() === "calendar"}>
            <CalendarList />
          </Match>
        </Switch>
        <SyncStatus />
      </aside>
      <Switch>
        <Match when={activeView() === "mail"}>
          <section class="shell-threads">
            <ThreadList />
          </section>
          <section class="shell-view">
            <ThreadView />
          </section>
        </Match>
        <Match when={activeView() === "contacts"}>
          <section class="shell-threads">
            <ContactList />
          </section>
          <section class="shell-view">
            <ContactView />
          </section>
        </Match>
        <Match when={activeView() === "calendar"}>
          <section class="shell-threads">
            <EventList />
          </section>
          <section class="shell-view">
            <EventView />
          </section>
        </Match>
      </Switch>
      <Show when={composeOpen()}>
        <Composer />
      </Show>
      <ToastHost />
    </div>
  );
}
