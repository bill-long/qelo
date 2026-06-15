import { describe, expect, it } from "vitest";
import type { EmailBodyPart } from "@/jmap/types";
import {
  attachmentParts,
  buildDraftEmail,
  type DraftAttachment,
  type DraftEmailInput,
  type InlineImage,
  inlineAttachmentParts,
  referencedInlineImages,
  sentFilePatch,
  splitForwardParts,
} from "./compose";

const baseInput: DraftEmailInput = {
  draftsMailboxId: "drafts1",
  from: { name: "Test One", email: "test@example.test" },
  to: [{ name: null, email: "a@x.io" }],
  cc: null,
  bcc: null,
  subject: "Hello",
  html: "<div>Body text</div>",
  text: "Body text",
};

describe("buildDraftEmail", () => {
  it("places the draft in Drafts with $draft + $seen and a multipart/alternative body", () => {
    const create = buildDraftEmail(baseInput);
    expect(create.mailboxIds).toEqual({ drafts1: true });
    expect(create.keywords).toEqual({ $draft: true, $seen: true });
    expect(create.from).toEqual([{ name: "Test One", email: "test@example.test" }]);
    expect(create.to).toEqual([{ name: null, email: "a@x.io" }]);
    expect(create.subject).toBe("Hello");
    // Both alternatives: a text/plain part and a text/html part, keyed by partId in bodyValues.
    expect(create.bodyValues).toEqual({
      text: { value: "Body text", isTruncated: false },
      html: { value: "<div>Body text</div>", isTruncated: false },
    });
    expect(create.textBody).toEqual([{ partId: "text", type: "text/plain" }]);
    expect(create.htmlBody).toEqual([{ partId: "html", type: "text/html" }]);
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

  it("omits attachments when absent or empty", () => {
    expect(buildDraftEmail(baseInput)).not.toHaveProperty("attachments");
    expect(buildDraftEmail({ ...baseInput, attachments: [] })).not.toHaveProperty("attachments");
  });

  it("includes shaped attachment parts when provided", () => {
    const create = buildDraftEmail({
      ...baseInput,
      attachments: [{ blobId: "B1", type: "image/png", name: "logo.png", size: 1234 }],
    });
    expect(create.attachments).toEqual([
      { blobId: "B1", type: "image/png", name: "logo.png", disposition: "attachment", size: 1234 },
    ]);
  });

  it("appends inline image parts (disposition inline + cid) when the body references them", () => {
    const create = buildDraftEmail({
      ...baseInput,
      html: '<div>hi</div><img src="cid:c1@qelo.invalid">',
      attachments: [{ blobId: "B1", type: "application/pdf", name: "a.pdf", size: 9 }],
      inlineImages: [
        { cid: "c1@qelo.invalid", blobId: "I1", type: "image/png", name: "p.png", size: 42 },
      ],
    });
    // Regular attachment first, then the inline part — both in the one attachments array.
    expect(create.attachments).toEqual([
      { blobId: "B1", type: "application/pdf", name: "a.pdf", disposition: "attachment", size: 9 },
      {
        blobId: "I1",
        type: "image/png",
        cid: "c1@qelo.invalid",
        disposition: "inline",
        size: 42,
        name: "p.png",
      },
    ]);
  });

  it("emits a blob attached AND inlined just once — as the inline part (no duplicate chip)", () => {
    const create = buildDraftEmail({
      ...baseInput,
      html: '<div>hi</div><img src="cid:c1@qelo.invalid">',
      attachments: [{ blobId: "SHARED", type: "image/png", name: "pic.png", size: 42 }],
      inlineImages: [
        { cid: "c1@qelo.invalid", blobId: "SHARED", type: "image/png", name: "pic.png", size: 42 },
      ],
    });
    expect(create.attachments).toEqual([
      {
        blobId: "SHARED",
        type: "image/png",
        cid: "c1@qelo.invalid",
        disposition: "inline",
        size: 42,
        name: "pic.png",
      },
    ]);
  });

  it("drops an inline image the body no longer references (inserted then deleted → no orphan part)", () => {
    const create = buildDraftEmail({
      ...baseInput,
      html: "<div>no image here anymore</div>",
      inlineImages: [
        { cid: "gone@qelo.invalid", blobId: "I1", type: "image/png", name: null, size: 42 },
      ],
    });
    expect(create).not.toHaveProperty("attachments");
  });
});

describe("attachmentParts", () => {
  const att: DraftAttachment = { blobId: "B1", type: "text/plain", name: "note.txt", size: 42 };

  it("returns undefined for no attachments (so the field is omitted entirely)", () => {
    expect(attachmentParts([])).toBeUndefined();
  });

  it("shapes each attachment into an EmailBodyPart with disposition 'attachment'", () => {
    expect(attachmentParts([att, { ...att, blobId: "B2", name: "two.txt" }])).toEqual([
      { blobId: "B1", type: "text/plain", name: "note.txt", disposition: "attachment", size: 42 },
      { blobId: "B2", type: "text/plain", name: "two.txt", disposition: "attachment", size: 42 },
    ]);
  });
});

// A server-read attachment part (RFC 8621 §4.1.4): the fields a forward/reply re-references.
function part(over: Partial<EmailBodyPart>): EmailBodyPart {
  return {
    partId: "2",
    blobId: "B1",
    size: 100,
    type: "application/pdf",
    charset: null,
    disposition: "attachment",
    cid: null,
    name: "report.pdf",
    ...over,
  };
}

describe("referencedInlineImages", () => {
  const img = part({ blobId: "I1", type: "image/png", name: "logo.png", cid: "c1@x", size: 42 });

  it("returns cid'd image parts the body actually references", () => {
    expect(referencedInlineImages([img], '<img src="cid:c1@x">')).toEqual([
      { cid: "c1@x", blobId: "I1", type: "image/png", name: "logo.png", size: 42 },
    ]);
  });

  it("skips a cid'd part the body does NOT reference (it'll become a chip instead)", () => {
    expect(referencedInlineImages([img], "<div>no image</div>")).toEqual([]);
  });

  it("skips parts without a cid or without a blobId (nothing to reference inline)", () => {
    expect(referencedInlineImages([part({ cid: null })], "x")).toEqual([]);
    expect(referencedInlineImages([part({ cid: "c@x", blobId: null })], "cid:c@x")).toEqual([]);
  });

  it("dedupes by cid and carries name:null + the type fallback", () => {
    expect(
      referencedInlineImages(
        [
          part({ blobId: "I1", cid: "c@x", type: "", name: null }),
          part({ blobId: "I2", cid: "c@x", type: "image/gif", name: "dup.gif" }),
        ],
        "cid:c@x",
      ),
    ).toEqual([
      { cid: "c@x", blobId: "I1", type: "application/octet-stream", name: null, size: 100 },
    ]);
  });

  it("does NOT false-match when one part's cid is a prefix of the referenced one", () => {
    // A forwarded message's cids are sender-controlled: `image001` must not match `cid:image001@host`.
    const prefix = part({ blobId: "P1", type: "image/png", cid: "image001", name: "p.png" });
    const real = part({ blobId: "R1", type: "image/png", cid: "image001@host", name: "r.png" });
    expect(referencedInlineImages([prefix, real], '<img src="cid:image001@host">')).toEqual([
      { cid: "image001@host", blobId: "R1", type: "image/png", name: "r.png", size: 100 },
    ]);
  });

  it("matches a CID: <img> case-insensitively in the scheme (the sanitizer keeps it)", () => {
    expect(referencedInlineImages([img], '<img src="CID:c1@x">')).toEqual([
      { cid: "c1@x", blobId: "I1", type: "image/png", name: "logo.png", size: 42 },
    ]);
  });

  it("does NOT match a `cid:` buried mid-URL (e.g. a link path), only one at a left boundary", () => {
    // A part with cid `c1@x` must not be 'referenced' just because some link path contains cid:c1@x.
    expect(referencedInlineImages([img], '<a href="https://host/path/cid:c1@x">link</a>')).toEqual(
      [],
    );
  });
});

describe("splitForwardParts", () => {
  it("re-references each non-inline part as a chip (a copy, not a re-upload)", () => {
    const { attachments, inlineImages } = splitForwardParts(
      [
        part({ blobId: "B1", type: "application/pdf", name: "report.pdf", size: 1000 }),
        part({ blobId: "B2", type: "text/csv", name: "data.csv", size: 50 }),
      ],
      "<div>body, no inline images</div>",
    );
    expect(inlineImages).toEqual([]);
    expect(attachments).toEqual([
      { blobId: "B1", type: "application/pdf", name: "report.pdf", size: 1000 },
      { blobId: "B2", type: "text/csv", name: "data.csv", size: 50 },
    ]);
  });

  it("splits referenced inline images out of the chips (truly inline) but keeps real attachments", () => {
    const { attachments, inlineImages } = splitForwardParts(
      [
        part({
          blobId: "I1",
          type: "image/png",
          name: "sig.png",
          disposition: "inline",
          cid: "c1@x",
        }),
        part({ blobId: "B1", type: "application/pdf", name: "report.pdf" }),
      ],
      '<blockquote><img src="cid:c1@x"></blockquote>',
    );
    expect(inlineImages).toEqual([
      { cid: "c1@x", blobId: "I1", type: "image/png", name: "sig.png", size: 100 },
    ]);
    // The inline image is NOT also a chip; the real attachment still is.
    expect(attachments).toEqual([
      { blobId: "B1", type: "application/pdf", name: "report.pdf", size: 100 },
    ]);
  });

  it("treats a cid'd part the body doesn't reference as an ordinary chip (not lost)", () => {
    const { attachments, inlineImages } = splitForwardParts(
      [part({ blobId: "I1", type: "image/png", name: "orphan.png", cid: "nope@x" })],
      "<div>body without that image</div>",
    );
    expect(inlineImages).toEqual([]);
    expect(attachments).toEqual([
      { blobId: "I1", type: "image/png", name: "orphan.png", size: 100 },
    ]);
  });

  it("skips parts without a blobId and dedupes identical blobIds to one chip", () => {
    const { attachments } = splitForwardParts(
      [
        part({ blobId: null, name: "phantom.txt" }),
        part({ blobId: "B1", name: "first.pdf" }),
        part({ blobId: "B1", name: "again.pdf" }),
      ],
      "<div>body</div>",
    );
    expect(attachments).toEqual([
      { blobId: "B1", type: "application/pdf", name: "first.pdf", size: 100 },
    ]);
  });

  it("falls back on a missing name/type the same way the reading pane + download path do", () => {
    const { attachments } = splitForwardParts(
      [part({ blobId: "B9", name: null, type: "" })],
      "<div>body</div>",
    );
    expect(attachments).toEqual([
      { blobId: "B9", type: "application/octet-stream", name: "attachment", size: 100 },
    ]);
  });

  it("does not ALSO surface a chip for bytes already kept inline (same blobId, one part)", () => {
    // The source carries the same image bytes both inline (cid'd) and as a separate part; a
    // content-addressed store returns one blobId. It should ride only as the inline image.
    const { attachments, inlineImages } = splitForwardParts(
      [
        part({
          blobId: "S1",
          type: "image/png",
          name: "pic.png",
          cid: "c1@x",
          disposition: "inline",
        }),
        part({ blobId: "S1", type: "image/png", name: "pic-again.png", disposition: "attachment" }),
      ],
      '<img src="cid:c1@x">',
    );
    expect(inlineImages).toEqual([
      { cid: "c1@x", blobId: "S1", type: "image/png", name: "pic.png", size: 100 },
    ]);
    expect(attachments).toEqual([]);
  });

  it("keeps a same-cid-but-different-blob part as a chip (no data loss; chip dedupe is by blobId)", () => {
    // A malformed source reuses one cid across two distinct blobs. referencedInlineImages dedupes by
    // cid (only the first is inline); the second distinct blob must still surface as a chip.
    const { attachments, inlineImages } = splitForwardParts(
      [
        part({
          blobId: "I1",
          type: "image/png",
          name: "a.png",
          cid: "dup@x",
          disposition: "inline",
        }),
        part({ blobId: "I2", type: "image/png", name: "b.png", cid: "dup@x" }),
      ],
      '<img src="cid:dup@x">',
    );
    expect(inlineImages).toEqual([
      { cid: "dup@x", blobId: "I1", type: "image/png", name: "a.png", size: 100 },
    ]);
    expect(attachments).toEqual([{ blobId: "I2", type: "image/png", name: "b.png", size: 100 }]);
  });
});

describe("inlineAttachmentParts", () => {
  const img: InlineImage = {
    cid: "c1@qelo.invalid",
    blobId: "I1",
    type: "image/png",
    name: "p.png",
    size: 42,
  };

  it("shapes a referenced inline image into a disposition:inline part with its cid", () => {
    expect(inlineAttachmentParts('<img src="cid:c1@qelo.invalid">', [img])).toEqual([
      {
        blobId: "I1",
        type: "image/png",
        cid: "c1@qelo.invalid",
        disposition: "inline",
        size: 42,
        name: "p.png",
      },
    ]);
  });

  it("omits name when the inline image has none", () => {
    const out = inlineAttachmentParts("cid:c@x", [
      { cid: "c@x", blobId: "I1", type: "image/png", name: null, size: 1 },
    ]);
    expect(out[0]).not.toHaveProperty("name");
  });

  it("filters out an inline image the html doesn't reference (no orphan part)", () => {
    expect(inlineAttachmentParts("<div>no image</div>", [img])).toEqual([]);
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
