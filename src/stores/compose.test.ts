import { describe, expect, it } from "vitest";
import { buildDraftEmail, type DraftEmailInput, sentFilePatch } from "./compose";

const baseInput: DraftEmailInput = {
  draftsMailboxId: "drafts1",
  from: { name: "Test One", email: "test@example.test" },
  to: [{ name: null, email: "a@x.io" }],
  cc: null,
  bcc: null,
  subject: "Hello",
  body: "Body text",
};

describe("buildDraftEmail", () => {
  it("places the draft in Drafts with $draft + $seen and a single text part", () => {
    const create = buildDraftEmail(baseInput);
    expect(create.mailboxIds).toEqual({ drafts1: true });
    expect(create.keywords).toEqual({ $draft: true, $seen: true });
    expect(create.from).toEqual([{ name: "Test One", email: "test@example.test" }]);
    expect(create.to).toEqual([{ name: null, email: "a@x.io" }]);
    expect(create.subject).toBe("Hello");
    expect(create.bodyValues).toEqual({ body: { value: "Body text", isTruncated: false } });
    expect(create.textBody).toEqual([{ partId: "body", type: "text/plain" }]);
  });

  it("omits cc/bcc and the reserved threading headers when absent", () => {
    const create = buildDraftEmail(baseInput);
    expect(create).not.toHaveProperty("cc");
    expect(create).not.toHaveProperty("bcc");
    expect(create).not.toHaveProperty("inReplyTo");
    expect(create).not.toHaveProperty("references");
  });

  it("includes cc/bcc and threading headers when provided", () => {
    const create = buildDraftEmail({
      ...baseInput,
      cc: [{ name: null, email: "c@x.io" }],
      bcc: [{ name: null, email: "b@x.io" }],
      inReplyTo: ["<parent@x.io>"],
      references: ["<root@x.io>", "<parent@x.io>"],
    });
    expect(create.cc).toEqual([{ name: null, email: "c@x.io" }]);
    expect(create.bcc).toEqual([{ name: null, email: "b@x.io" }]);
    expect(create.inReplyTo).toEqual(["<parent@x.io>"]);
    expect(create.references).toEqual(["<root@x.io>", "<parent@x.io>"]);
  });
});

describe("sentFilePatch", () => {
  it("clears $draft, sets $seen, and moves Drafts→Sent when a Sent mailbox exists", () => {
    expect(sentFilePatch("drafts1", "sent1")).toEqual({
      "keywords/$draft": null,
      "keywords/$seen": true,
      "mailboxIds/drafts1": null,
      "mailboxIds/sent1": true,
    });
  });

  it("only clears $draft + sets $seen (no move) when there is no Sent mailbox", () => {
    expect(sentFilePatch("drafts1")).toEqual({
      "keywords/$draft": null,
      "keywords/$seen": true,
    });
  });
});
