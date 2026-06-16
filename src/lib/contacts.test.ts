import { describe, expect, it } from "vitest";
import type { AddressBook, ContactCard } from "@/jmap/types";
import {
  cardMayWrite,
  cardToEditable,
  compareAddressBooks,
  compareContacts,
  contactDisplayName,
  contactInBook,
  contactMatchesQuery,
  contactNominalName,
  type EditableContact,
  editableToCard,
  editableToPatch,
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

describe("cardMayWrite", () => {
  const writable = { rw: book({ id: "rw", myRights: { ...book({}).myRights, mayWrite: true } }) };
  const readonly = { ro: book({ id: "ro" }) }; // mayWrite: false by default

  it("is true when ANY of the card's books grants mayWrite", () => {
    expect(cardMayWrite(card({ addressBookIds: { rw: true } }), writable)).toBe(true);
  });

  it("is false when the card's books are all read-only, or the book is unknown", () => {
    expect(cardMayWrite(card({ addressBookIds: { ro: true } }), readonly)).toBe(false);
    expect(cardMayWrite(card({ addressBookIds: { gone: true } }), writable)).toBe(false);
    expect(cardMayWrite(card({}), writable)).toBe(false);
  });
});

describe("cardToEditable", () => {
  it("flattens every editable property, preserving the server map keys", () => {
    const c = card({
      name: { full: "Ada Lovelace", components: [{ kind: "given", value: "Ada" }] },
      nicknames: { n1: { name: "Countess" } },
      emails: { e1: { address: "ada@x.test", pref: 1 } },
      phones: { p1: { number: "+1-555-0100" } },
      addresses: { a1: { full: "1 Engine Way" } },
      organizations: { o1: { name: "Acme" } },
      titles: { t1: { name: "Analyst" } },
      notes: { note1: { note: "Met at conf" } },
      onlineServices: { s1: { service: "Mastodon", user: "@ada", uri: "https://m.test/@ada" } },
    });
    const e = cardToEditable(c);
    expect(e.nameFull).toBe("Ada Lovelace");
    expect(e.emails).toEqual([{ key: "e1", value: "ada@x.test" }]);
    expect(e.phones).toEqual([{ key: "p1", value: "+1-555-0100" }]);
    expect(e.addresses).toEqual([{ key: "a1", value: "1 Engine Way" }]);
    expect(e.onlineServices).toEqual([
      { key: "s1", service: "Mastodon", user: "@ada", uri: "https://m.test/@ada" },
    ]);
  });

  it("shows a component-only address as empty (only `full` is editable)", () => {
    const c = card({
      addresses: { a1: { components: [{ kind: "locality", value: "Townsville" }] } },
    });
    expect(cardToEditable(c).addresses).toEqual([{ key: "a1", value: "" }]);
  });
});

// Build an EditableContact from a card, then apply a mutation to it before round-tripping.
function editableOf(c: ContactCard, mutate: (e: EditableContact) => void): EditableContact {
  const e = cardToEditable(c);
  mutate(e);
  return e;
}

describe("editableToPatch", () => {
  it("returns an empty patch when nothing changed (open + save round-trips cleanly)", () => {
    const c = card({
      name: { full: "Ada", components: [{ kind: "given", value: "Ada" }] },
      emails: { e1: { address: "ada@x.test", pref: 1 } },
      phones: { p1: { number: "+1-555-0100" } },
    });
    expect(editableToPatch(c, cardToEditable(c))).toEqual({});
  });

  it("patches only the changed property, by whole-property pointer", () => {
    const c = card({ name: { full: "Ada" }, emails: { e1: { address: "ada@x.test" } } });
    const patch = editableToPatch(
      c,
      editableOf(c, (e) => {
        e.nameFull = "Ada Lovelace";
      }),
    );
    expect(patch).toEqual({ name: { full: "Ada Lovelace" } });
  });

  it("carries un-edited sub-fields (pref/contexts) through an edited entry", () => {
    const c = card({
      emails: { e1: { address: "old@x.test", pref: 1, contexts: { work: true } } },
    });
    const patch = editableToPatch(
      c,
      editableOf(c, (e) => {
        const first = e.emails[0];
        if (first) first.value = "new@x.test";
      }),
    );
    expect(patch).toEqual({
      emails: { e1: { address: "new@x.test", pref: 1, contexts: { work: true } } },
    });
  });

  it("adds a new entry under a fresh key and removes a cleared one", () => {
    const c = card({ emails: { e1: { address: "first@x.test" } } });
    const added = editableToPatch(
      c,
      editableOf(c, (e) => {
        e.emails.push({ key: null, value: "second@x.test" });
      }),
    );
    expect(added.emails).toEqual({
      e1: { address: "first@x.test" },
      c0: { address: "second@x.test" },
    });

    const removed = editableToPatch(
      c,
      editableOf(c, (e) => {
        e.emails = [];
      }),
    );
    expect(removed).toEqual({ emails: null }); // whole property removed
  });

  it("preserves name.components when only full changes, and removes name when fully cleared", () => {
    const c = card({ name: { full: "Ada", components: [{ kind: "given", value: "Ada" }] } });
    expect(
      editableToPatch(
        c,
        editableOf(c, (e) => {
          e.nameFull = "Ada L";
        }),
      ),
    ).toEqual({ name: { full: "Ada L", components: [{ kind: "given", value: "Ada" }] } });

    const onlyFull = card({ name: { full: "Ada" } });
    expect(
      editableToPatch(
        onlyFull,
        editableOf(onlyFull, (e) => {
          e.nameFull = "";
        }),
      ),
    ).toEqual({ name: null });
  });

  it("preserves a component-only address (blank `full`) untouched when an unrelated field changes", () => {
    // Regression: the editable model surfaces such an address as an empty `full`; an unrelated edit
    // must NOT drop its components. The address stays out of the patch entirely (server keeps it).
    const c = card({
      name: { full: "Ada" },
      addresses: {
        ad1: { components: [{ kind: "locality", value: "Townsville" }], isOrdered: true },
      },
    });
    const patch = editableToPatch(
      c,
      editableOf(c, (e) => {
        e.nameFull = "Ada Lovelace";
      }),
    );
    expect(patch).toEqual({ name: { full: "Ada Lovelace" } }); // addresses untouched
    // And the optimistic card keeps the address.
    const next = editableToCard(
      c,
      editableOf(c, (e) => {
        e.nameFull = "Ada Lovelace";
      }),
    );
    expect(next.addresses).toEqual({
      ad1: { components: [{ kind: "locality", value: "Townsville" }], isOrdered: true },
    });
  });

  it("preserves an organization carrying only `units` (no editable name)", () => {
    const c = card({ organizations: { o1: { units: [{ name: "R&D" }] } }, name: { full: "Ada" } });
    const patch = editableToPatch(
      c,
      editableOf(c, (e) => {
        e.nameFull = "Ada L";
      }),
    );
    expect(patch).toEqual({ name: { full: "Ada L" } }); // organizations untouched
  });

  it("drops an existing entry only when clearing its leaf leaves nothing", () => {
    // An email whose sole field is the address: clearing it removes the entry (no orphan).
    const c = card({ emails: { e1: { address: "a@x.test" } } });
    const patch = editableToPatch(
      c,
      editableOf(c, (e) => {
        const first = e.emails[0];
        if (first) first.value = "";
      }),
    );
    expect(patch).toEqual({ emails: null });
  });

  it("drops a blank-value entry rather than persisting it", () => {
    const c = card({ emails: { e1: { address: "a@x.test" } } });
    const patch = editableToPatch(
      c,
      editableOf(c, (e) => {
        e.emails.push({ key: null, value: "   " });
      }),
    );
    expect(patch).toEqual({}); // the blank addition is ignored, so nothing changed
  });

  it("drops an online service with neither user nor uri", () => {
    const c = card({ onlineServices: { s1: { service: "X", user: "@me" } } });
    const patch = editableToPatch(
      c,
      editableOf(c, (e) => {
        e.onlineServices.push({ key: null, service: "Label only", user: "", uri: "" });
      }),
    );
    expect(patch).toEqual({});
  });

  it("does not mutate untouched values: open + save is a no-op even with whitespace/odd data", () => {
    // A note with a trailing newline, an email, a name with a trailing space, and an online service
    // that has neither user nor uri (a degenerate but real server entry). Saving without editing
    // anything must produce no patch — no whitespace stripping, no dropped service.
    const c = card({
      name: { full: "Ada " },
      emails: { e1: { address: "ada@x.test" } },
      notes: { n1: { note: "Met at conf\n" } },
      onlineServices: { s1: { service: "Old", contexts: { work: true } } },
    });
    expect(editableToPatch(c, cardToEditable(c))).toEqual({});
  });

  it("preserves an existing online service with only a label/contexts when another field changes", () => {
    const c = card({
      name: { full: "Ada" },
      onlineServices: { s1: { service: "Old", contexts: { work: true } } },
    });
    const patch = editableToPatch(
      c,
      editableOf(c, (e) => {
        e.nameFull = "Ada Lovelace";
      }),
    );
    expect(patch).toEqual({ name: { full: "Ada Lovelace" } }); // onlineServices untouched
  });
});

describe("editableToCard", () => {
  it("applies edits while carrying through un-exposed properties (kind, addressBookIds)", () => {
    const c = card({
      kind: "individual",
      addressBookIds: { b: true },
      name: { full: "Ada" },
      emails: { e1: { address: "ada@x.test" } },
    });
    const next = editableToCard(
      c,
      editableOf(c, (e) => {
        e.nameFull = "Ada Lovelace";
      }),
    );
    expect(next.name?.full).toBe("Ada Lovelace");
    expect(next.kind).toBe("individual");
    expect(next.addressBookIds).toEqual({ b: true });
    expect(next.emails).toEqual({ e1: { address: "ada@x.test" } });
    expect(c.name?.full).toBe("Ada"); // original untouched (new object)
  });

  it("removes an emptied property from the optimistic card", () => {
    const c = card({ name: { full: "Ada" }, phones: { p1: { number: "+1-555" } } });
    const next = editableToCard(
      c,
      editableOf(c, (e) => {
        e.phones = [];
      }),
    );
    expect(next.phones).toBeUndefined();
  });
});
