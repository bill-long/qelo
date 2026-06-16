import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { ContactView } from "@/components/contacts/ContactView";
import { NewContactButton } from "@/components/contacts/NewContactButton";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { resetContacts, setAddressBooks, setContactCards } from "@/stores/contacts";
import {
  creatingContact,
  setCreatingContact,
  setSelectedAddressBookId,
  setSelectedContactId,
} from "@/stores/ui";

function book(partial: Partial<AddressBook>): AddressBook {
  return {
    id: "b",
    name: "Book",
    description: null,
    sortOrder: 0,
    isDefault: false,
    isSubscribed: false,
    myRights: { mayRead: true, mayWrite: false, mayDelete: false, mayShare: false },
    ...partial,
  };
}

const writableBook = book({
  id: "wb",
  isDefault: true,
  myRights: { mayRead: true, mayWrite: true, mayDelete: true, mayShare: true },
});

function reset() {
  resetContacts();
  setSelectedContactId(null);
  setSelectedAddressBookId(null);
  setCreatingContact(false);
}

afterEach(() => {
  cleanup();
  reset();
});

describe("NewContactButton", () => {
  it("is hidden until a writable address book exists, then offers to create", () => {
    reset();
    render(() => <NewContactButton />);
    expect(screen.queryByRole("button", { name: /new contact/i })).toBeNull();

    setAddressBooks({ wb: writableBook });
    expect(screen.getByRole("button", { name: /new contact/i })).toBeTruthy();
  });

  it("opens the create form even when a contact is already selected", () => {
    // The regression guard: ContactView's on(selectedContactId) effect runs AFTER the (batched) click
    // handler. If the button also cleared the selection, that effect would reset creatingContact back
    // to false and the form would never open. With a contact selected, clicking New must still open it.
    reset();
    const card: ContactCard = {
      "@type": "Card",
      version: "1.0",
      id: "c1",
      addressBookIds: { wb: true },
      name: { full: "Ada Lovelace" },
    };
    setAddressBooks({ wb: writableBook });
    setContactCards({ c1: card });
    setSelectedContactId("c1");

    render(() => (
      <>
        <NewContactButton />
        <ContactView />
      </>
    ));

    // The selected contact's detail shows; the create form does not yet.
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "New contact" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /new contact/i }));

    expect(creatingContact()).toBe(true);
    expect(screen.getByRole("heading", { name: "New contact" })).toBeTruthy();
  });
});
