import { describe, expect, it } from "vitest";
import type { Email } from "@/jmap/types";
import {
  forwardQuoteHtml,
  forwardSubject,
  plainTextBody,
  replyQuoteHtml,
  replyRecipients,
  replySubject,
  threadingHeaders,
} from "./reply";

// A minimal Email slice the builders read. Tests pass just the fields each builder touches; this
// helper fills a realistic baseline so individual cases override only what they exercise.
function source(over: Partial<Email> = {}): Email {
  return {
    id: "e1",
    blobId: "b1",
    threadId: "t1",
    mailboxIds: {},
    keywords: {},
    size: 0,
    receivedAt: "2026-06-13T14:32:00Z",
    messageId: ["<msg-1@example.test>"],
    inReplyTo: null,
    references: null,
    from: [{ name: "Ada Sender", email: "ada@example.test" }],
    to: [{ name: "Me", email: "me@example.test" }],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Project plan",
    sentAt: null,
    hasAttachment: false,
    preview: "preview snippet",
    bodyValues: {
      t: { value: "line one\n\nline two", isEncodingProblem: false, isTruncated: false },
    },
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
    htmlBody: undefined,
    attachments: undefined,
    ...over,
  };
}

describe("replySubject", () => {
  it("prefixes Re: on a bare subject", () => {
    expect(replySubject("Project plan")).toBe("Re: Project plan");
  });
  it("does not double-prefix an existing Re: (case/space insensitive)", () => {
    expect(replySubject("Re: Project plan")).toBe("Re: Project plan");
    expect(replySubject("re:Project plan")).toBe("re:Project plan");
    expect(replySubject("  RE :  Project plan")).toBe("RE :  Project plan");
  });
  it("handles a null/empty subject", () => {
    expect(replySubject(null)).toBe("Re: ");
    expect(replySubject("")).toBe("Re: ");
  });
});

describe("forwardSubject", () => {
  it("prefixes Fwd: on a bare subject", () => {
    expect(forwardSubject("Project plan")).toBe("Fwd: Project plan");
  });
  it("does not double-prefix an existing Fwd:/Fw:", () => {
    expect(forwardSubject("Fwd: Project plan")).toBe("Fwd: Project plan");
    expect(forwardSubject("fw: Project plan")).toBe("fw: Project plan");
  });
  it("does NOT treat a Re: subject as already forwarded", () => {
    expect(forwardSubject("Re: Project plan")).toBe("Fwd: Re: Project plan");
  });
});

describe("replyRecipients", () => {
  it("reply: To is the sender, no Cc", () => {
    const { to, cc } = replyRecipients(source(), { all: false, self: [] });
    expect(to).toEqual(["ada@example.test"]);
    expect(cc).toEqual([]);
  });

  it("reply: prefers replyTo over from", () => {
    const email = source({ replyTo: [{ name: null, email: "list@example.test" }] });
    const { to } = replyRecipients(email, { all: false, self: [] });
    expect(to).toEqual(["list@example.test"]);
  });

  it("reply-all: Cc gathers original to + cc", () => {
    const email = source({
      to: [
        { name: null, email: "me@example.test" },
        { name: null, email: "bob@example.test" },
      ],
      cc: [{ name: null, email: "carol@example.test" }],
    });
    const { to, cc } = replyRecipients(email, { all: true, self: [] });
    expect(to).toEqual(["ada@example.test"]);
    expect(cc).toEqual(["me@example.test", "bob@example.test", "carol@example.test"]);
  });

  it("reply-all: excludes the user's own identity addresses from Cc (case-insensitive)", () => {
    const email = source({
      to: [
        { name: null, email: "Me@Example.test" },
        { name: null, email: "bob@example.test" },
      ],
      cc: [{ name: null, email: "alias@example.test" }],
    });
    const { cc } = replyRecipients(email, {
      all: true,
      self: ["me@example.test", "ALIAS@example.test"],
    });
    expect(cc).toEqual(["bob@example.test"]);
  });

  it("reply-all: dedupes an address appearing in both to and cc, and the sender already in To", () => {
    const email = source({
      from: [{ name: null, email: "ada@example.test" }],
      to: [
        { name: null, email: "ada@example.test" },
        { name: null, email: "bob@example.test" },
      ],
      cc: [{ name: null, email: "BOB@example.test" }],
    });
    const { to, cc } = replyRecipients(email, { all: true, self: [] });
    expect(to).toEqual(["ada@example.test"]);
    expect(cc).toEqual(["bob@example.test"]); // ada already in To, bob deduped across to/cc
  });

  it("does not self-filter the To address (replying to your own message)", () => {
    const email = source({ from: [{ name: null, email: "me@example.test" }] });
    const { to } = replyRecipients(email, { all: false, self: ["me@example.test"] });
    expect(to).toEqual(["me@example.test"]);
  });
});

describe("threadingHeaders", () => {
  it("sets inReplyTo to the source messageId and appends it to the references chain", () => {
    const email = source({
      messageId: ["<msg-2@example.test>"],
      references: ["<root@example.test>", "<msg-1@example.test>"],
    });
    expect(threadingHeaders(email)).toEqual({
      inReplyTo: ["<msg-2@example.test>"],
      references: ["<root@example.test>", "<msg-1@example.test>", "<msg-2@example.test>"],
    });
  });

  it("starts a fresh references chain when the source has none", () => {
    const email = source({ messageId: ["<msg-1@example.test>"], references: null });
    expect(threadingHeaders(email)).toEqual({
      inReplyTo: ["<msg-1@example.test>"],
      references: ["<msg-1@example.test>"],
    });
  });

  it("yields nulls when the source has no messageId (nothing to thread on)", () => {
    expect(threadingHeaders(source({ messageId: null }))).toEqual({
      inReplyTo: null,
      references: null,
    });
  });

  it("references only the single parent id when a malformed source has multiple messageIds", () => {
    const email = source({
      messageId: ["<a@x.test>", "<b@x.test>"],
      references: ["<root@x.test>"],
    });
    expect(threadingHeaders(email)).toEqual({
      inReplyTo: ["<a@x.test>"],
      references: ["<root@x.test>", "<a@x.test>"],
    });
  });
});

describe("plainTextBody", () => {
  it("returns the fetched text/plain part value", () => {
    expect(plainTextBody(source())).toBe("line one\n\nline two");
  });

  it("falls back to the preview when there is no plain-text part", () => {
    const email = source({ textBody: [], bodyValues: {}, preview: "snippet" });
    expect(plainTextBody(email)).toBe("snippet");
  });

  it("falls back to the preview for an HTML-only message (textBody holds the html part)", () => {
    // An HTML-only message lists its text/html part in textBody; quoting that markup would be
    // wrong, so plainTextBody must skip it and use the preview.
    const email = source({
      preview: "snippet",
      bodyValues: { h: { value: "<p>hi</p>", isEncodingProblem: false, isTruncated: false } },
      textBody: [
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
    });
    expect(plainTextBody(email)).toBe("snippet");
  });
});

// The Email factory in source() is plain-text-only (htmlBody undefined), so its quote promotes the
// plain text to escaped HTML; htmlSource() overrides with a real text/html part.
function htmlSource(over: Partial<Email> = {}): Email {
  return source({
    bodyValues: {
      h: { value: "<p>Hello <b>there</b></p>", isEncodingProblem: false, isTruncated: false },
    },
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
    ...over,
  });
}

describe("replyQuoteHtml", () => {
  it("opens with a blank block, an attribution div, and the source HTML in a blockquote", () => {
    const body = replyQuoteHtml(htmlSource());
    expect(body.startsWith("<div><br></div>")).toBe(true);
    expect(body).toContain("<div>On ");
    expect(body).toContain("Ada Sender wrote:</div>");
    expect(body).toContain("<blockquote><p>Hello <b>there</b></p></blockquote>");
  });

  it("promotes a plain-text-only source to escaped HTML with <br> line breaks", () => {
    const body = replyQuoteHtml(source());
    expect(body).toContain("<blockquote>line one<br><br>line two</blockquote>");
  });

  it("normalizes CRLF/CR newlines in a plain-text source (no stray \\r left)", () => {
    const crlf = source({
      bodyValues: { t: { value: "a\r\nb\rc", isEncodingProblem: false, isTruncated: false } },
    });
    const body = replyQuoteHtml(crlf);
    expect(body).toContain("<blockquote>a<br>b<br>c</blockquote>");
    expect(body).not.toContain("\r");
  });

  it("escapes HTML-significant characters in the attribution (a hostile sender name)", () => {
    const body = replyQuoteHtml(htmlSource({ from: [{ name: "<script>", email: "x@y.test" }] }));
    expect(body).toContain("&lt;script&gt; wrote:");
    expect(body).not.toContain("<script>");
  });
});

describe("forwardQuoteHtml", () => {
  it("emits a forwarded-message header block then the source HTML in a blockquote", () => {
    const body = forwardQuoteHtml(htmlSource());
    expect(body.startsWith("<div><br></div>")).toBe(true);
    expect(body).toContain("<div>---------- Forwarded message ----------</div>");
    expect(body).toContain("<div>From: Ada Sender</div>");
    expect(body).toContain("<div>Subject: Project plan</div>");
    expect(body).toContain("<div>To: Me</div>");
    expect(body).toContain("<blockquote><p>Hello <b>there</b></p></blockquote>");
  });
});
