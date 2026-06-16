import { createMemo, For } from "solid-js";
import { compareAddressBooks } from "@/lib/contacts";
import { addressBooks } from "@/stores/contacts";
import { selectedAddressBookId, setSelectedAddressBookId, setSelectedContactId } from "@/stores/ui";

/**
 * The contacts-view sidebar (column 1, where MailboxList sits in mail view): an "All contacts"
 * entry plus one row per address book. Selecting a book filters the contact list to it; "All"
 * (the null selection) shows every card. Mirrors MailboxList's single-`<nav>` landmark + row look.
 */
export function AddressBookList() {
  const books = createMemo(() => Object.values(addressBooks).sort(compareAddressBooks));
  return (
    <nav class="addressbook-list" aria-label="Address books">
      <AddressBookRow id={null} name="All contacts" />
      <For each={books()}>{(book) => <AddressBookRow id={book.id} name={book.name} />}</For>
    </nav>
  );
}

function AddressBookRow(props: { id: string | null; name: string }) {
  const isSelected = () => selectedAddressBookId() === props.id;
  return (
    <button
      type="button"
      class="addressbook-row"
      classList={{ "is-selected": isSelected() }}
      aria-current={isSelected() ? "true" : undefined}
      // Clear the open contact when switching books — the previously-selected card may not be in the
      // newly-filtered list, which would leave the detail pane showing a contact the list doesn't.
      onClick={() => {
        setSelectedAddressBookId(props.id);
        setSelectedContactId(null);
      }}
    >
      <span class="addressbook-name">{props.name}</span>
    </button>
  );
}
