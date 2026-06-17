import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { ContactView } from "@/components/contacts/ContactView";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { resetContacts, setAddressBooks, setContactCards } from "@/stores/contacts";
import { setCreatingContact, setSelectedAddressBookId, setSelectedContactId } from "@/stores/ui";

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

const deletableBook = book({
  id: "db",
  isDefault: true,
  myRights: { mayRead: true, mayWrite: true, mayDelete: true, mayShare: true },
});
const readonlyBook = book({ id: "rb" }); // mayDelete: false

function makeCard(id: string, bookId: string, full: string): ContactCard {
  return {
    "@type": "Card",
    version: "1.0",
    id,
    addressBookIds: { [bookId]: true },
    name: { full },
  };
}

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

describe("ContactView delete affordance", () => {
  it("shows the Delete button only when the card's book grants mayDelete", () => {
    reset();
    setAddressBooks({ rb: readonlyBook });
    setContactCards({ c1: makeCard("c1", "rb", "Read Only") });
    setSelectedContactId("c1");

    render(() => <ContactView />);
    expect(screen.getByRole("heading", { name: "Read Only" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("confirms in two steps and cancels back to the actions without deleting", () => {
    reset();
    setAddressBooks({ db: deletableBook });
    setContactCards({ c1: makeCard("c1", "db", "Ada Lovelace") });
    setSelectedContactId("c1");

    render(() => <ContactView />);

    // Step 1: the Delete button is present; no confirm prompt yet.
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /confirm delete/i })).toBeNull();

    // Step 2: clicking Delete arms the inline confirm (prompt naming the contact + Cancel).
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("group", { name: /confirm delete/i });
    expect(confirm.textContent).toContain("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    // The Edit button is hidden while confirming (the actions row is swapped out).
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();

    // Cancel disarms: the actions row returns, the contact stays in the store.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: /confirm delete/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("resets an armed confirm when the selected contact changes", () => {
    // Show doesn't re-mount ContactDetail between two truthy cards, so the confirm must reset on the
    // card-id change (the on(card.id) effect) — else it would carry to the next contact.
    reset();
    setAddressBooks({ db: deletableBook });
    setContactCards({
      c1: makeCard("c1", "db", "Ada Lovelace"),
      c2: makeCard("c2", "db", "Grace Hopper"),
    });
    setSelectedContactId("c1");

    render(() => <ContactView />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("group", { name: /confirm delete/i })).toBeTruthy();

    setSelectedContactId("c2");
    expect(screen.getByRole("heading", { name: "Grace Hopper" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /confirm delete/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});
