import { describe, expect, it } from "vitest";
import type { ContactCard, Email, EmailAddress } from "@/jmap/types";
import {
  activeFragment,
  buildSuggestionIndex,
  completeFragment,
  matchRecipients,
  type RecipientSuggestion,
} from "./recipients";

// A minimal Email carrying just the recipient fields buildSuggestionIndex reads.
function email(parts: { to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] }): Email {
  return {
    to: parts.to ?? null,
    cc: parts.cc ?? null,
    bcc: parts.bcc ?? null,
  } as Email;
}

const addr = (email: string, name: string | null = null): EmailAddress => ({ name, email });

// A minimal JSContact Card with a name + ordered emails (pref 1, 2, …) for the contacts source.
function contact(name: string | null, ...emails: string[]): ContactCard {
  return {
    "@type": "Card",
    version: "1.0",
    id: name ?? emails[0] ?? "x",
    ...(name ? { name: { full: name } } : {}),
    emails: Object.fromEntries(emails.map((address, i) => [`e${i}`, { address, pref: i + 1 }])),
  };
}

describe("buildSuggestionIndex", () => {
  it("collects to/cc/bcc addresses across messages", () => {
    const index = buildSuggestionIndex([
      email({ to: [addr("a@x.io")], cc: [addr("b@x.io")], bcc: [addr("c@x.io")] }),
    ]);
    expect(index.map((s) => s.email).sort()).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
  });

  it("dedupes by lowercased email and counts occurrences for frequency ranking", () => {
    // a@x.io appears 3×, b@x.io 1× → a ranks first regardless of casing.
    const index = buildSuggestionIndex([
      email({ to: [addr("A@x.io")] }),
      email({ to: [addr("a@X.io"), addr("b@x.io")] }),
      email({ to: [addr("a@x.io")] }),
    ]);
    expect(index.map((s) => s.email)).toEqual(["A@x.io", "b@x.io"]);
    expect(index).toHaveLength(2);
  });

  it("counts an address once per message even if it appears in several fields of that message", () => {
    // dup@x.io is in both to and cc of ONE message → frequency 1, NOT 2; solo@x.io once. Equal
    // count, so recency (encounter order) decides: dup (rank 0) before solo (rank 1).
    const index = buildSuggestionIndex([
      email({ to: [addr("dup@x.io")], cc: [addr("dup@x.io")] }),
      email({ to: [addr("solo@x.io")] }),
    ]);
    expect(index.map((s) => s.email)).toEqual(["dup@x.io", "solo@x.io"]);
    // A second message addressing dup@x.io would make it 2 and clearly outrank solo.
    const index2 = buildSuggestionIndex([
      email({ to: [addr("dup@x.io")], cc: [addr("dup@x.io")] }),
      email({ to: [addr("solo@x.io")] }),
      email({ to: [addr("solo@x.io")] }),
    ]);
    expect(index2.map((s) => s.email)).toEqual(["solo@x.io", "dup@x.io"]);
  });

  it("breaks frequency ties by recency (newest-first input)", () => {
    // Both appear once; the more recent (earlier in the newest-first list) wins the tie.
    const index = buildSuggestionIndex([
      email({ to: [addr("recent@x.io")] }),
      email({ to: [addr("older@x.io")] }),
    ]);
    expect(index.map((s) => s.email)).toEqual(["recent@x.io", "older@x.io"]);
  });

  it("keeps the first verbatim address but backfills a name a later sighting supplies", () => {
    const index = buildSuggestionIndex([
      email({ to: [addr("Person@x.io", null)] }),
      email({ to: [addr("person@x.io", "The Person")] }),
    ]);
    expect(index).toEqual<RecipientSuggestion[]>([{ email: "Person@x.io", name: "The Person" }]);
  });

  it("ignores empty/whitespace-only addresses", () => {
    const index = buildSuggestionIndex([email({ to: [addr(""), addr("  "), addr("ok@x.io")] })]);
    expect(index.map((s) => s.email)).toEqual(["ok@x.io"]);
  });

  it("treats an exotic local part as an ordinary key (no prototype pollution)", () => {
    const index = buildSuggestionIndex([email({ to: [addr("__proto__@x.io")] })]);
    expect(index.map((s) => s.email)).toEqual(["__proto__@x.io"]);
  });
});

describe("buildSuggestionIndex with the contacts source", () => {
  it("adds contact addresses the user never emailed", () => {
    const index = buildSuggestionIndex([], [contact("Ada Lovelace", "ada@x.io")]);
    expect(index).toEqual<RecipientSuggestion[]>([{ email: "ada@x.io", name: "Ada Lovelace" }]);
  });

  it("ranks a contact above a one-off Sent address but below a frequently-emailed one", () => {
    // freq@x.io: emailed twice (count 2). once@x.io: emailed once (count 1). ada: contact, never
    // emailed (floor 1.5). Expected order: freq (2) > ada (1.5) > once (1).
    const index = buildSuggestionIndex(
      [
        email({ to: [addr("freq@x.io")] }),
        email({ to: [addr("freq@x.io")] }),
        email({ to: [addr("once@x.io")] }),
      ],
      [contact("Ada Lovelace", "ada@x.io")],
    );
    expect(index.map((s) => s.email)).toEqual(["freq@x.io", "ada@x.io", "once@x.io"]);
  });

  it("dedupes a contact that's also in Sent, keeping Sent frequency and preferring the contact name", () => {
    // both@x.io: emailed once (with a Sent display name) AND a saved contact. One entry, lifted to
    // the contact floor (so it leads the count-1 stranger), with the CURATED contact name.
    const index = buildSuggestionIndex(
      [email({ to: [addr("both@x.io", "Sent Name")] }), email({ to: [addr("stranger@x.io")] })],
      [contact("Curated Name", "both@x.io")],
    );
    expect(index).toEqual<RecipientSuggestion[]>([
      { email: "both@x.io", name: "Curated Name" },
      { email: "stranger@x.io", name: null },
    ]);
  });

  it("keeps the Sent name when the contact has no nominal name", () => {
    // A nameless contact (email-only) must not blank out a name the Sent sighting supplied.
    const index = buildSuggestionIndex(
      [email({ to: [addr("x@x.io", "Sent Name")] })],
      [contact(null, "x@x.io")],
    );
    expect(index).toEqual<RecipientSuggestion[]>([{ email: "x@x.io", name: "Sent Name" }]);
  });

  it("orders two never-emailed contacts deterministically by name", () => {
    const index = buildSuggestionIndex(
      [],
      [contact("Zoe", "zoe@x.io"), contact("Aaron", "aaron@x.io")],
    );
    expect(index.map((s) => s.email)).toEqual(["aaron@x.io", "zoe@x.io"]);
  });

  it("contributes every address of a multi-email contact, deduped by lowercased address", () => {
    const index = buildSuggestionIndex(
      [email({ to: [addr("WORK@x.io")] })],
      [contact("Multi", "work@x.io", "home@x.io")],
    );
    expect(index.map((s) => s.email).sort()).toEqual(["WORK@x.io", "home@x.io"]);
    // The Sent-verbatim casing is kept; both carry the contact name.
    expect(index.every((s) => s.name === "Multi")).toBe(true);
  });
});

describe("matchRecipients", () => {
  const index: RecipientSuggestion[] = [
    { email: "alice@example.com", name: "Alice Smith" },
    { email: "bob@example.com", name: "Bob Jones" },
    { email: "carol@other.org", name: null },
  ];

  it("returns nothing for an empty/whitespace query", () => {
    expect(matchRecipients(index, "")).toEqual([]);
    expect(matchRecipients(index, "   ")).toEqual([]);
  });

  it("matches a case-insensitive substring of the email", () => {
    expect(matchRecipients(index, "OTHER").map((s) => s.email)).toEqual(["carol@other.org"]);
  });

  it("matches a case-insensitive substring of the display name", () => {
    expect(matchRecipients(index, "jones").map((s) => s.email)).toEqual(["bob@example.com"]);
  });

  it("preserves the index's best-first ranking", () => {
    expect(matchRecipients(index, "example").map((s) => s.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });

  it("excludes already-entered addresses (lowercased) and the fully-typed address itself", () => {
    expect(
      matchRecipients(index, "example", 6, new Set(["alice@example.com"])).map((s) => s.email),
    ).toEqual(["bob@example.com"]);
    expect(matchRecipients(index, "bob@example.com").map((s) => s.email)).toEqual([]);
  });

  it("caps the result at the limit", () => {
    expect(matchRecipients(index, "example", 1).map((s) => s.email)).toEqual(["alice@example.com"]);
  });
});

describe("activeFragment", () => {
  it("returns the whole value when there is one address", () => {
    expect(activeFragment("alice@x.io", 5)).toEqual({ start: 0, end: 10, text: "alice@x.io" });
  });

  it("isolates the fragment the caret sits in (whitespace bounds it, matching the parser)", () => {
    const value = "a@x.io, bo, c@x.io";
    // caret inside "bo"; the fragment is bounded by the space before it and the comma after it.
    expect(activeFragment(value, 10)).toEqual({ start: 8, end: 10, text: "bo" });
  });

  it("handles a caret at the very end (new trailing fragment)", () => {
    const value = "a@x.io, ";
    expect(activeFragment(value, value.length)).toMatchObject({ start: 8, text: "" });
  });

  it("treats comma, semicolon, and whitespace as separators", () => {
    expect(activeFragment("a@x.io; b@x.io", 14)).toMatchObject({ start: 8, text: "b@x.io" });
    // A space-separated field (valid per parseRecipients) isolates the caret's address, not the whole.
    expect(activeFragment("a@x.io bo", 9)).toMatchObject({ start: 7, text: "bo" });
  });

  it("clamps an out-of-range caret", () => {
    expect(activeFragment("a@x.io", 99).text).toBe("a@x.io");
    expect(activeFragment("a@x.io", -5).text).toBe("a@x.io");
  });
});

describe("completeFragment", () => {
  it("completes the only fragment, leaving a trailing separator", () => {
    expect(completeFragment("al", 2, "alice@x.io")).toEqual({
      value: "alice@x.io, ",
      caret: 12,
    });
  });

  it("completes a trailing fragment after an existing address with single-space spacing", () => {
    const value = "bob@x.io, al";
    const result = completeFragment(value, value.length, "alice@x.io");
    expect(result.value).toBe("bob@x.io, alice@x.io, ");
    expect(result.caret).toBe(result.value.length);
  });

  it("completes a middle fragment and preserves the addresses after it", () => {
    const value = "bob@x.io, al, carol@x.io";
    // caret inside "al"
    const result = completeFragment(value, 12, "alice@x.io");
    expect(result.value).toBe("bob@x.io, alice@x.io, carol@x.io");
    expect(result.caret).toBe("bob@x.io, alice@x.io, ".length);
  });

  it("normalizes a missing space after the separator", () => {
    expect(completeFragment("bob@x.io,al", 11, "alice@x.io").value).toBe("bob@x.io, alice@x.io, ");
  });

  it("completes a space-separated fragment, canonicalizing to a comma-space join", () => {
    const value = "bob@x.io al";
    const result = completeFragment(value, value.length, "alice@x.io");
    expect(result.value).toBe("bob@x.io, alice@x.io, ");
    expect(result.caret).toBe(result.value.length);
  });

  it("canonicalizes a following semicolon separator to a comma-space", () => {
    // caret inside "al"
    expect(completeFragment("al; carol@x.io", 2, "alice@x.io").value).toBe(
      "alice@x.io, carol@x.io",
    );
  });
});
