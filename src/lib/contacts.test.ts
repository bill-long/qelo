import { describe, expect, it } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import {
  compareAddressBooks,
  compareContacts,
  contactDisplayName,
  contactInBook,
  contactMatchesQuery,
  contactNominalName,
  primaryEmail,
  sortedEmails,
} from "./contacts";

function card(partial: Partial<ContactCard>): ContactCard {
  return { "@type": "Card", version: "1.0", id: "x", ...partial };
}

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

describe("contactDisplayName", () => {
  it("prefers name.full", () => {
    expect(contactDisplayName(card({ name: { full: "Ada Lovelace" } }))).toBe("Ada Lovelace");
  });

  it("falls back to joined components, skipping separators", () => {
    const c = card({
      name: {
        components: [
          { kind: "given", value: "Ada" },
          { kind: "separator", value: ", " },
          { kind: "surname", value: "Lovelace" },
        ],
        isOrdered: true,
      },
    });
    expect(contactDisplayName(c)).toBe("Ada Lovelace");
  });

  it("ignores an empty-string full and blank components", () => {
    const c = card({
      name: { full: "  ", components: [{ kind: "given", value: "  " }] },
      organizations: { o1: { name: "Analytical Engine Co" } },
    });
    expect(contactDisplayName(c)).toBe("Analytical Engine Co");
  });

  it("falls back to organization, then primary email, then nickname", () => {
    expect(contactDisplayName(card({ organizations: { o1: { name: "Acme" } } }))).toBe("Acme");
    expect(contactDisplayName(card({ emails: { e1: { address: "a@x.test" } } }))).toBe("a@x.test");
    expect(contactDisplayName(card({ nicknames: { n1: { name: "Countess" } } }))).toBe("Countess");
  });

  it("returns a stable fallback when nothing is usable", () => {
    expect(contactDisplayName(card({}))).toBe("(no name)");
  });
});

describe("contactNominalName", () => {
  it("returns a real name (full, components, org, or nickname)", () => {
    expect(contactNominalName(card({ name: { full: "Ada Lovelace" } }))).toBe("Ada Lovelace");
    expect(contactNominalName(card({ organizations: { o1: { name: "Acme" } } }))).toBe("Acme");
    expect(contactNominalName(card({ nicknames: { n1: { name: "Countess" } } }))).toBe("Countess");
  });

  it("returns null when the card has no nominal name", () => {
    expect(contactNominalName(card({}))).toBeNull();
  });

  it("returns null rather than echoing an address back as the name", () => {
    // contactDisplayName would fall back to the (primary) email here; a suggestion already shows it.
    const c = card({ emails: { a: { address: "solo@x.test" } } });
    expect(contactDisplayName(c)).toBe("solo@x.test");
    expect(contactNominalName(c)).toBeNull();
  });

  it("nulls the name even when the fallback email is a DIFFERENT address of the card", () => {
    // No name → contactDisplayName picks the primary (pref 1) email; the other address must not be
    // surfaced as that address's "name".
    const c = card({
      emails: { a: { address: "second@x.test" }, b: { address: "first@x.test", pref: 1 } },
    });
    expect(contactDisplayName(c)).toBe("first@x.test");
    expect(contactNominalName(c)).toBeNull();
  });
});

describe("sortedEmails / primaryEmail", () => {
  it("orders by pref (1 = most preferred), absent prefs last in insertion order", () => {
    const c = card({
      emails: {
        a: { address: "third@x.test" },
        b: { address: "first@x.test", pref: 1 },
        c: { address: "second@x.test", pref: 5 },
      },
    });
    expect(sortedEmails(c).map((e) => e.address)).toEqual([
      "first@x.test",
      "second@x.test",
      "third@x.test",
    ]);
    expect(primaryEmail(c)).toBe("first@x.test");
  });

  it("drops entries with no address and returns undefined when there are none", () => {
    expect(sortedEmails(card({ emails: { a: { address: "" } } }))).toEqual([]);
    expect(primaryEmail(card({}))).toBeUndefined();
  });
});

describe("compareContacts", () => {
  it("sorts by display name, case-insensitively", () => {
    const a = card({ id: "1", name: { full: "ada" } });
    const b = card({ id: "2", name: { full: "Bob" } });
    expect(compareContacts(a, b)).toBeLessThan(0);
    expect(compareContacts(b, a)).toBeGreaterThan(0);
  });

  it("breaks ties on id for a stable order", () => {
    const a = card({ id: "1", name: { full: "Sam" } });
    const b = card({ id: "2", name: { full: "Sam" } });
    expect(compareContacts(a, b)).toBeLessThan(0);
    expect(compareContacts(a, a)).toBe(0);
  });
});

describe("contactInBook", () => {
  it("matches every card for the null (All contacts) pseudo-book", () => {
    expect(contactInBook(card({}), null)).toBe(true);
  });

  it("matches only cards whose addressBookIds include the book", () => {
    const c = card({ addressBookIds: { b1: true } });
    expect(contactInBook(c, "b1")).toBe(true);
    expect(contactInBook(c, "b2")).toBe(false);
    expect(contactInBook(card({}), "b1")).toBe(false);
  });
});

describe("contactMatchesQuery", () => {
  const c = card({
    name: { full: "Ada Lovelace" },
    emails: { e1: { address: "ada@example.test" } },
    organizations: { o1: { name: "Analytical Engine Co" } },
  });

  it("matches everything on an empty/whitespace query", () => {
    expect(contactMatchesQuery(c, "")).toBe(true);
    expect(contactMatchesQuery(c, "  ")).toBe(true);
  });

  it("matches case-insensitively on name, email, or organization", () => {
    expect(contactMatchesQuery(c, "lovel")).toBe(true);
    expect(contactMatchesQuery(c, "ADA@EXAMPLE")).toBe(true);
    expect(contactMatchesQuery(c, "engine")).toBe(true);
    expect(contactMatchesQuery(c, "zzz")).toBe(false);
  });

  it("matches a nickname even when it isn't the display name", () => {
    const withNick = card({ name: { full: "Augusta King" }, nicknames: { n1: { name: "Ada" } } });
    expect(contactDisplayName(withNick)).toBe("Augusta King");
    expect(contactMatchesQuery(withNick, "ada")).toBe(true);
  });
});

describe("compareAddressBooks", () => {
  it("puts the default book first, then sortOrder, then name", () => {
    const def = book({ id: "1", name: "Zed", isDefault: true, sortOrder: 9 });
    const a = book({ id: "2", name: "Work", sortOrder: 1 });
    const b = book({ id: "3", name: "Personal", sortOrder: 2 });
    expect([b, a, def].sort(compareAddressBooks).map((x) => x.id)).toEqual(["1", "2", "3"]);
  });
});
