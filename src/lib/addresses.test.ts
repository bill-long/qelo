import { describe, expect, it } from "vitest";
import { invalidRecipients, isValidEmail, parseRecipients, splitRecipients } from "./addresses";

describe("isValidEmail", () => {
  it("accepts a plain address (trimming surrounding whitespace)", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("  user@example.test  ")).toBe(true);
  });

  it("rejects obvious non-addresses", () => {
    for (const bad of ["", "foo", "foo@bar", "@example.test", "a b@example.test", "a@b.c"]) {
      expect(isValidEmail(bad), bad).toBe(false);
    }
  });
});

describe("splitRecipients", () => {
  it("splits on commas, semicolons, and whitespace and drops empties", () => {
    expect(splitRecipients("a@x.io, b@x.io ; c@x.io")).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
    expect(splitRecipients("   ")).toEqual([]);
  });
});

describe("parseRecipients", () => {
  it("maps valid addresses to EmailAddress objects with a null name", () => {
    expect(parseRecipients("a@x.io, b@x.io")).toEqual([
      { name: null, email: "a@x.io" },
      { name: null, email: "b@x.io" },
    ]);
  });

  it("drops invalid tokens but keeps the valid ones", () => {
    expect(parseRecipients("good@x.io, nope")).toEqual([{ name: null, email: "good@x.io" }]);
  });

  it("returns null when there is no valid recipient (so the caller omits the field)", () => {
    expect(parseRecipients("")).toBeNull();
    expect(parseRecipients("nope, alsonope")).toBeNull();
  });
});

describe("invalidRecipients", () => {
  it("returns only the tokens that aren't valid addresses", () => {
    expect(invalidRecipients("good@x.io, nope, also@bad")).toEqual(["nope", "also@bad"]);
    expect(invalidRecipients("good@x.io")).toEqual([]);
  });
});
