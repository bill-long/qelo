import { describe, expect, it } from "vitest";
import type { Email } from "@/jmap/types";
import { selectBody } from "./body";

/** Minimal Email with just the body-related fields the selector reads. */
function email(p: Partial<Email>): Email {
  return { id: "e", ...p } as Email;
}

describe("selectBody", () => {
  it("prefers HTML when its part value is present", () => {
    const e = email({
      htmlBody: [
        {
          partId: "h",
          blobId: null,
          size: 0,
          type: "text/html",
          charset: null,
          disposition: null,
          cid: null,
          name: null,
        },
      ],
      textBody: [
        {
          partId: "t",
          blobId: null,
          size: 0,
          type: "text/plain",
          charset: null,
          disposition: null,
          cid: null,
          name: null,
        },
      ],
      bodyValues: {
        h: { value: "<p>hi</p>", isEncodingProblem: false, isTruncated: false },
        t: { value: "hi", isEncodingProblem: false, isTruncated: false },
      },
    });
    expect(selectBody(e)).toEqual({ kind: "html", value: "<p>hi</p>" });
  });

  it("falls back to text when there is no HTML part value", () => {
    const e = email({
      textBody: [
        {
          partId: "t",
          blobId: null,
          size: 0,
          type: "text/plain",
          charset: null,
          disposition: null,
          cid: null,
          name: null,
        },
      ],
      bodyValues: { t: { value: "plain", isEncodingProblem: false, isTruncated: false } },
    });
    expect(selectBody(e)).toEqual({ kind: "text", value: "plain" });
  });

  it("returns none when no body values are available", () => {
    expect(selectBody(email({}))).toEqual({ kind: "none", value: "" });
  });

  it("does not treat an HTML part as usable when its value wasn't fetched", () => {
    const e = email({
      htmlBody: [
        {
          partId: "h",
          blobId: null,
          size: 0,
          type: "text/html",
          charset: null,
          disposition: null,
          cid: null,
          name: null,
        },
      ],
      textBody: [
        {
          partId: "t",
          blobId: null,
          size: 0,
          type: "text/plain",
          charset: null,
          disposition: null,
          cid: null,
          name: null,
        },
      ],
      bodyValues: { t: { value: "plain", isEncodingProblem: false, isTruncated: false } },
    });
    expect(selectBody(e)).toEqual({ kind: "text", value: "plain" });
  });
});
