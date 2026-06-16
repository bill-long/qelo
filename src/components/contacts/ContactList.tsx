import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import {
  compareContacts,
  contactDisplayName,
  contactInBook,
  contactMatchesQuery,
  primaryEmail,
} from "@/lib/contacts";
import { contactCards, contactsReady, loadContacts } from "@/stores/contacts";
import { selectedAddressBookId, selectedContactId, setSelectedContactId } from "@/stores/ui";

/**
 * The contact list (column 2, where ThreadList sits in mail view): a search box over a
 * name-sorted list of the selected address book's cards. Loads contacts on first mount (lazy —
 * mail-only sessions never fetch them); the load-once guard makes a mail⇄contacts toggle cheap.
 */
export function ContactList() {
  // Lazy first load. loadContacts is idempotent + never rejects, so firing it on every mount is safe.
  onMount(() => void loadContacts());

  const [search, setSearch] = createSignal("");

  const visible = createMemo(() =>
    Object.values(contactCards)
      .filter((c) => contactInBook(c, selectedAddressBookId()) && contactMatchesQuery(c, search()))
      .sort(compareContacts),
  );

  return (
    <div class="contact-list">
      <div class="contact-search">
        <input
          type="search"
          placeholder="Search contacts"
          aria-label="Search contacts"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>
      <Show when={contactsReady()} fallback={<p class="contact-list-note">Loading…</p>}>
        <Show
          when={visible().length > 0}
          fallback={
            // An empty search never filters anything out, so it can only mean the (selected) book
            // is empty — "No matches" applies only once a query has actually excluded cards.
            <p class="contact-list-note">{search().trim() === "" ? "No contacts" : "No matches"}</p>
          }
        >
          <ul class="contact-rows">
            <For each={visible()}>{(card) => <ContactRow id={card.id} />}</For>
          </ul>
        </Show>
      </Show>
    </div>
  );
}

function ContactRow(props: { id: string }) {
  const card = () => contactCards[props.id];
  const isSelected = () => selectedContactId() === props.id;
  return (
    <Show when={card()}>
      {(c) => (
        <li>
          <button
            type="button"
            class="contact-row"
            classList={{ "is-selected": isSelected() }}
            aria-current={isSelected() ? "true" : undefined}
            onClick={() => setSelectedContactId(props.id)}
          >
            <span class="contact-row-name">{contactDisplayName(c())}</span>
            <Show when={primaryEmail(c())}>
              {(email) => <span class="contact-row-email">{email()}</span>}
            </Show>
          </button>
        </li>
      )}
    </Show>
  );
}
