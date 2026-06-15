import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import {
  CAP_CORE,
  CAP_MAIL,
  CAP_SUBMISSION,
  type EmailPatch,
  emailSet,
  emailSubmissionSet,
  identityGet,
  methodResult,
  setResult,
} from "@/jmap/methods";
import type { Email, EmailAddress, EmailBodyPart, EmailSubmission, Identity } from "@/jmap/types";
import { invalidRecipients, parseRecipients } from "@/lib/addresses";
import { htmlToText } from "@/lib/html-text";
import {
  forwardQuoteHtml,
  forwardSubject,
  replyQuoteHtml,
  replyRecipients,
  replySubject,
  threadingHeaders,
} from "@/lib/reply";
import { sanitizeOutboundHtml } from "@/lib/sanitize";
import { handleAuthFailure, jmap } from "./account";
import { mailboxIdByRole } from "./mailboxes";
import { notify } from "./toasts";

// Compose v1 (D3): plain-text body only, new message only. The headline JMAP payoff lives in
// send(): one batched Email/set{create #draft} + EmailSubmission/set{create, onSuccessUpdateEmail}
// round trip that creates the message, submits it, and files it Drafts→Sent atomically. We do NOT
// advance any sync cursor from these /sets — the push-driven drain owns that, and will surface the
// new Sent/Drafts/Inbox rows on its own (same discipline as the keyword/mailbox mutations).

// --- Pure builders (unit-tested) -------------------------------------------

/**
 * An attachment already uploaded to the blob store (its bytes POSTed via `JmapClient.upload`),
 * carrying the server-assigned `blobId` an `Email/set` create references plus the `type`/`size`
 * the server recorded and the local file `name`. The draft holds these; send/saveDraft just let
 * the blobIds ride the existing create — no extra round trip beyond the one-per-file upload.
 */
export interface DraftAttachment {
  blobId: string;
  type: string;
  name: string;
  size: number;
}

/**
 * An inline image embedded in the body: its bytes uploaded to the blob store (or, on forward/reply,
 * the source part's existing blob re-referenced), keyed by a `cid` that an `<img src="cid:…">` in
 * `bodyHtml` points at. On send it becomes an `attachments` part with `disposition: "inline"` + the
 * matching `cid` (RFC 8621 §4.1.4), so the server assembles a multipart/related body and the
 * recipient sees the image in place rather than as a download. `name` rides through when the source
 * had one (inline images often don't).
 */
export interface InlineImage {
  /** Content-ID with no angle brackets, as referenced by `cid:<cid>` in the HTML and stored on the part. */
  cid: string;
  blobId: string;
  type: string;
  size: number;
  name: string | null;
}

export interface DraftEmailInput {
  draftsMailboxId: string;
  from: EmailAddress;
  /** Parsed recipients, or null to omit the field (no recipients of that kind). */
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  subject: string;
  /** The composed body as sanitized HTML (the `text/html` part). */
  html: string;
  /** The plain-text alternative derived from the HTML (the `text/plain` part). */
  text: string;
  // Threading headers — reserved for PR 4 (reply/forward); always null in v1.
  inReplyTo?: string[] | null;
  references?: string[] | null;
  /** Uploaded attachments to reference by blobId; omitted/empty → no `attachments` field. */
  attachments?: DraftAttachment[];
  /** Inline images referenced by `cid:` in {@link html}; emitted as `disposition: "inline"` parts. */
  inlineImages?: InlineImage[];
}

/**
 * Shape uploaded attachments into the `attachments` EmailBodyPart[] an `Email/set` create carries
 * (RFC 8621 §4.1.4): each part references its uploaded `blobId` with `disposition: "attachment"`,
 * and reuses the server-recorded `type`/`size` plus the file `name`. Returns `undefined` when there
 * are none so {@link buildDraftEmail} can omit the field entirely rather than send an empty array.
 */
export function attachmentParts(
  attachments: DraftAttachment[],
): Array<Record<string, unknown>> | undefined {
  if (attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    blobId: a.blobId,
    type: a.type,
    name: a.name,
    disposition: "attachment",
    size: a.size,
  }));
}

/**
 * The set of `cid` tokens an actual `<img src="cid:…">` in `html` embeds. Only an `<img src>` counts
 * — NOT a bare `cid:` token in quoted text, nor an `<a href="cid:…">` — so forwarding attacker
 * HTML can't silently promote one of the source's parts to inline (and hide it from the attachment
 * chips) just by mentioning its cid. Pulls each `<img>`'s `src` (quoted or bare, attributes in any
 * order), case-insensitively on the scheme (the outbound sanitizer keeps a `CID:` <img>), and keeps
 * the token verbatim — so a cid that's a *prefix* of another's (`image001` vs `image001@host`) isn't
 * a false positive either. Shared by the carry-forward filter and the send-time orphan filter.
 */
function cidsReferencedIn(html: string): Set<string> {
  const refs = new Set<string>();
  for (const tag of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const src = (tag[1] ?? tag[2] ?? tag[3] ?? "").trim();
    const cid = /^cid:(.+)$/i.exec(src);
    if (cid?.[1]) refs.add(cid[1]);
  }
  return refs;
}

/**
 * Whether a part's MIME type is eligible to ride as an inline image. Only `image/*` qualifies, plus
 * an unknown/generic type (blank or `application/octet-stream`) where the server simply didn't record
 * one — a missing type on a cid-referenced part is most likely an image with absent metadata. A
 * clearly-non-image type (`application/pdf`, `text/*`, …) is excluded so it can't be hidden from the
 * forward attachment chips or carried as an un-renderable inline part on reply.
 */
function isInlineImageType(type: string): boolean {
  const t = type.toLowerCase();
  return t === "" || t === "application/octet-stream" || t.startsWith("image/");
}

/**
 * The source parts that are inline images *actually referenced* by a `cid:` in `html` — i.e. the
 * ones a reply/forward should keep truly inline by re-referencing their existing `blobId`s (a
 * server-side copy, NOT a re-upload). A part qualifies only with both a `cid` and a `blobId` AND a
 * matching `cid:<cid>` in the body; a cid'd part the body doesn't reference falls through to be a
 * regular attachment chip instead (see {@link splitForwardParts}) rather than vanishing. Deduped by
 * `cid` (the body references each once).
 */
export function referencedInlineImages(parts: EmailBodyPart[], html: string): InlineImage[] {
  const refs = cidsReferencedIn(html);
  const out: InlineImage[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const { cid, blobId } = part;
    if (!cid || !blobId || seen.has(cid)) continue;
    if (!refs.has(cid)) continue;
    // A cid-referenced part that's clearly not an image (e.g. application/pdf) stays a regular
    // attachment chip rather than being hidden as an un-renderable inline part.
    if (!isInlineImageType(part.type)) continue;
    seen.add(cid);
    out.push({
      cid,
      blobId,
      type: part.type || "application/octet-stream",
      name: part.name,
      size: part.size,
    });
  }
  return out;
}

/**
 * Partition a forwarded message's parts into the two ways a forward carries them: inline images that
 * stay inline (re-referenced by `cid` in the rebuilt HTML body — {@link referencedInlineImages}) and
 * everything else as ordinary attachment {@link DraftAttachment} chips. Both re-reference the
 * *source* message's existing `blobId`s (a server-side copy, NOT a re-upload). A part without a
 * `blobId` can't be referenced, so it's skipped from chips; the inline ones are excluded from chips
 * so a `cid`'d image isn't shown twice. Identical blobs collapse to one chip (a content-addressed
 * store returns one `blobId` for byte-identical parts), matching {@link attachFiles}, so
 * `removeAttachment(blobId)` can't be left dropping a duplicate. The server-recorded `type`/`size`
 * ride through; a missing `name`/`type` falls back the same way the reading pane + download path do.
 */
export function splitForwardParts(
  parts: EmailBodyPart[],
  html: string,
): { attachments: DraftAttachment[]; inlineImages: InlineImage[] } {
  const inlineImages = referencedInlineImages(parts, html);
  const attachments: DraftAttachment[] = [];
  // Seed the dedupe set with the inline images' blobIds so a byte-identical *other* part (a
  // content-addressed store hands back one blobId) isn't ALSO shown as a chip — a blob referenced
  // inline is emitted once, as the inline part. Dedupe is purely by blobId, NOT by cid: a malformed
  // source could reuse one cid across two distinct blobs, and skipping the second by cid would drop
  // it entirely (neither inline — referencedInlineImages dedupes by cid — nor a chip). A real Set
  // (not an object) so an exotic blobId like "__proto__" is just an ordinary key.
  const seen = new Set<string>(inlineImages.map((i) => i.blobId));
  for (const part of parts) {
    const blobId = part.blobId;
    if (!blobId || seen.has(blobId)) continue;
    seen.add(blobId);
    attachments.push({
      blobId,
      type: part.type || "application/octet-stream",
      name: part.name ?? "attachment",
      size: part.size,
    });
  }
  return { attachments, inlineImages };
}

/**
 * Shape the inline images referenced in `html` into `attachments` parts with `disposition: "inline"`
 * + their `cid` (RFC 8621 §4.1.4). Filtered against the (sanitized) `html` so an image the user
 * inserted then deleted — its `cid` no longer in the body — doesn't ride along as an orphan part.
 */
export function inlineAttachmentParts(
  html: string,
  inlineImages: InlineImage[],
): Array<Record<string, unknown>> {
  const refs = cidsReferencedIn(html);
  return inlineImages
    .filter((img) => refs.has(img.cid))
    .map((img) => {
      const part: Record<string, unknown> = {
        blobId: img.blobId,
        type: img.type,
        cid: img.cid,
        disposition: "inline",
        size: img.size,
      };
      if (img.name) part.name = img.name;
      return part;
    });
}

/**
 * Build the `Email/set` `create` object for a draft: it lives in the Drafts mailbox and carries
 * `$draft` (+ `$seen`, since the author has obviously seen their own draft). The body is sent as
 * multipart/alternative — a `text/html` part (the rich-text the user composed) plus a `text/plain`
 * alternative derived from it (RFC 8621 §4.1.4): two `bodyValues` keyed by partId, referenced by
 * `htmlBody` and `textBody` respectively, and the server assembles the MIME tree. Recipient/threading
 * fields are omitted entirely when absent rather than sent as null, keeping the wire object minimal.
 * Inline images referenced by `cid:` in the body ride the same `attachments` array as ordinary
 * attachments, tagged `disposition: "inline"` so the server builds a multipart/related body.
 */
export function buildDraftEmail(input: DraftEmailInput): Record<string, unknown> {
  const create: Record<string, unknown> = {
    mailboxIds: { [input.draftsMailboxId]: true },
    keywords: { $draft: true, $seen: true },
    from: [input.from],
    subject: input.subject,
    bodyValues: {
      text: { value: input.text, isTruncated: false },
      html: { value: input.html, isTruncated: false },
    },
    textBody: [{ partId: "text", type: "text/plain" }],
    htmlBody: [{ partId: "html", type: "text/html" }],
  };
  if (input.to) create.to = input.to;
  if (input.cc) create.cc = input.cc;
  if (input.bcc) create.bcc = input.bcc;
  if (input.inReplyTo) create.inReplyTo = input.inReplyTo;
  if (input.references) create.references = input.references;
  // Inline images win over a byte-identical chip: a blob referenced inline (the body shows it) is
  // emitted once, as the inline part — never also as a disposition:attachment part with the same
  // blobId (which would duplicate it and, lacking a cid, leave the body's <img> with a backing part
  // that doesn't render in place). This restores the all-parts dedupe the single forward path had.
  const inline = inlineAttachmentParts(input.html, input.inlineImages ?? []);
  const inlineBlobIds = new Set(inline.map((p) => p.blobId as string));
  const regular = (attachmentParts(input.attachments ?? []) ?? []).filter(
    (p) => !inlineBlobIds.has(p.blobId as string),
  );
  const attachments = [...regular, ...inline];
  if (attachments.length > 0) create.attachments = attachments;
  return create;
}

/**
 * The `onSuccessUpdateEmail` patch that files a just-sent draft (RFC 8621 §7.5): clear `$draft`,
 * set `$seen`, and move it Drafts→Sent. If the account exposes no Sent mailbox the message simply
 * stays in Drafts (only `$draft` is cleared) rather than being orphaned out of every mailbox.
 */
export function sentFilePatch(draftsMailboxId: string, sentMailboxId?: string): EmailPatch {
  const patch: EmailPatch = { "keywords/$draft": null, "keywords/$seen": true };
  if (sentMailboxId) {
    patch[`mailboxIds/${draftsMailboxId}`] = null;
    patch[`mailboxIds/${sentMailboxId}`] = true;
  }
  return patch;
}

// --- Reactive compose state ------------------------------------------------

export interface DraftState {
  /** Raw recipient fields exactly as typed; parsed to EmailAddress[] on save/send. */
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  /** The composed body as HTML (the RichTextEditor's canonical output). */
  bodyHtml: string;
  // Reserved for PR 4 (reply threading); always null in v1.
  inReplyTo: string[] | null;
  references: string[] | null;
  /** Already-uploaded attachments (see {@link attachFiles}); ride the create as blobId refs. */
  attachments: DraftAttachment[];
  /** Inline images embedded in {@link bodyHtml} by `cid:` (see {@link insertInlineImage}). */
  inlineImages: InlineImage[];
}

// A fresh blank draft. A factory (not a shared const) so each reset gets its own `attachments`
// array — every entry point spreads this, and a shared array could otherwise be aliased across
// drafts. The reactive store reconciles per field, so spreading the factory result resets cleanly.
function emptyDraft(): DraftState {
  return {
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    bodyHtml: "",
    inReplyTo: null,
    references: null,
    attachments: [],
    inlineImages: [],
  };
}

export const [draft, setDraft] = createStore<DraftState>(emptyDraft());
export const [identities, setIdentities] = createSignal<Identity[]>([]);
export const [selectedIdentityId, setSelectedIdentityId] = createSignal<string | null>(null);
export const [composeOpen, setComposeOpen] = createSignal(false);
/** Which submit is in flight (gates the buttons + drives their labels), or null when idle. */
export const [busy, setBusy] = createSignal<null | "send" | "save">(null);
/** True while one or more attachment uploads are in flight (gates send/save). */
export const [uploading, setUploading] = createSignal(false);
export const [composeError, setComposeError] = createSignal<string | null>(null);

// Bumped every time the draft is opened or reset. An in-flight attachFiles captures the value at
// the start and only appends/clears state while it still matches — so an upload that resolves after
// the user discarded (or reopened) the composer can't graft a stale attachment onto a different
// draft. We can't abort the network upload (no AbortController), but this keeps a late resolution
// harmless, which is what lets discard stay available during an upload instead of trapping the user.
let draftGeneration = 0;

/** The chosen sending identity, defaulting to the first the account exposes. */
export function selectedIdentity(): Identity | undefined {
  const id = selectedIdentityId();
  const list = identities();
  return list.find((i) => i.id === id) ?? list[0];
}

/** Patch one draft field (the binding the Composer inputs dispatch through). */
export function updateDraft<K extends keyof DraftState>(field: K, value: DraftState[K]): void {
  setDraft(field, value);
}

function closeAndReset(): void {
  draftGeneration += 1; // supersede any in-flight upload so it can't append to the next draft
  setComposeOpen(false);
  setDraft(emptyDraft());
  setUploading(false);
  setComposeError(null);
}

// Open the composer on a specific initial draft, loading identities on first use. Every entry
// point (blank compose, reply, forward) funnels through here so the emptyDraft() reset can't clobber
// a prefill — the caller hands the fully-formed draft in, it isn't reset then patched. Bumping the
// generation supersedes any upload still in flight from a previous open, so it can't append onto
// this fresh draft.
function openWith(initial: DraftState): void {
  draftGeneration += 1;
  setDraft(initial);
  setUploading(false);
  setComposeError(null);
  setComposeOpen(true);
  if (identities().length === 0) void loadIdentities();
}

/** Open the composer on a fresh blank message, loading identities on first use. */
export function openComposer(): void {
  openWith(emptyDraft());
}

// The user's own identity addresses (lowercased by replyRecipients), used to keep reply-all from
// Cc'ing the sender themselves. Shell eager-loads identities on mount so this is normally populated
// before the first reply; in the rare window before that resolves, self-exclusion is a no-op and
// the user can drop their own address from the (visible, editable) Cc — we don't block the snappy
// open on the async Identity/get.
function selfAddresses(): string[] {
  return identities().map((i) => i.email);
}

/**
 * Open the composer as a reply to `email`: To = its Reply-To/From (plus, for `all`, the other
 * recipients minus the user's own addresses), subject "Re: …" (no double-prefix), a quoted body,
 * and the threading headers (inReplyTo/references) that keep the reply in the same thread. The
 * draft create already passes those headers through (buildDraftEmail), so send() needs no change.
 */
export function startReply(email: Email, opts: { all?: boolean } = {}): void {
  const { to, cc } = replyRecipients(email, { all: opts.all ?? false, self: selfAddresses() });
  const headers = threadingHeaders(email);
  // The quote may embed the source's inline (cid'd) images; re-reference their blobs so they stay
  // inline in the sent reply rather than rendering broken (the outbound sanitizer keeps cid <img>,
  // but a cid with no backing part would be a dead reference). Regular attachments are NOT carried
  // on a reply — only the inline images the quoted body actually shows.
  const bodyHtml = replyQuoteHtml(email);
  openWith({
    ...emptyDraft(),
    to: to.join(", "),
    cc: cc.join(", "),
    subject: replySubject(email.subject),
    bodyHtml,
    inlineImages: referencedInlineImages(email.attachments ?? [], bodyHtml),
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  });
}

/**
 * Open the composer to forward `email`: recipients are left empty (the user picks them), subject
 * is "Fwd: …" (no double-prefix), and the body carries a forwarded-message header block + the
 * original text. A forward starts a NEW thread, so no threading headers are set. The source's
 * binary parts are re-referenced by their existing `blobId`s (a server-side copy, not a re-upload —
 * see {@link splitForwardParts}): inline (cid'd) images the quoted body shows stay truly inline,
 * while real attachments become chips; the quoted text lives in the body as before.
 */
export function startForward(email: Email): void {
  const bodyHtml = forwardQuoteHtml(email);
  const { attachments, inlineImages } = splitForwardParts(email.attachments ?? [], bodyHtml);
  openWith({
    ...emptyDraft(),
    subject: forwardSubject(email.subject),
    bodyHtml,
    attachments,
    inlineImages,
  });
}

/** Discard the in-progress message and close the composer. */
export function discardDraft(): void {
  closeAndReset();
}

/** Reset all compose state — a test seam; app flow goes through open/discard. */
export function resetCompose(): void {
  draftGeneration += 1;
  setDraft(emptyDraft());
  setIdentities([]);
  setSelectedIdentityId(null);
  setComposeOpen(false);
  setBusy(null);
  setUploading(false);
  setComposeError(null);
}

// The clear "this account can't send" message, shared by every entry point that needs the
// submission capability (Identity/get and EmailSubmission/set both live under it).
const NO_SUBMISSION_MESSAGE = "This account can't send mail (no submission capability).";

/** Fetch the account's sending identities and default the selection to the first. */
export async function loadIdentities(): Promise<void> {
  try {
    const client = jmap();
    // Identity/get is itself under the submission capability, so a non-sending account (e.g. a
    // read-only token) would 404/error here too — fail fast with the same clear message as send().
    if (!client.accountHasCapability(CAP_SUBMISSION)) {
      setComposeError(NO_SUBMISSION_MESSAGE);
      return;
    }
    const responses = await client.request(
      [identityGet(client.accountId, "i")],
      [CAP_CORE, CAP_MAIL, CAP_SUBMISSION],
    );
    const list = (methodResult(responses, "i").list ?? []) as Identity[];
    setIdentities(list);
    // Default the selection to the first identity, and also REVISE it if a reload dropped the
    // previously-selected one — otherwise the <select> would hold a value matching no option.
    const current = selectedIdentityId();
    if (!current || !list.some((i) => i.id === current)) {
      setSelectedIdentityId(list[0]?.id ?? null);
    }
  } catch (err) {
    if (handleAuthFailure(err)) return;
    setComposeError(err instanceof Error ? err.message : String(err));
  }
}

// Every mistyped token across to/cc/bcc. parseRecipients DROPS invalid tokens, so saving or
// sending without this check would silently lose a mistyped recipient — both actions reject on a
// non-empty result rather than send to a partial set the user never confirmed.
function invalidDraftRecipients(): string[] {
  return [
    ...invalidRecipients(draft.to),
    ...invalidRecipients(draft.cc),
    ...invalidRecipients(draft.bcc),
  ];
}

// Build the draft create object from the current reactive state + a resolved identity. The composed
// HTML is sanitized HERE — the authoritative outbound pass — before it becomes the text/html part,
// and the text/plain alternative is derived from the *sanitized* HTML so the two parts agree.
function currentDraftCreate(draftsId: string, identity: Identity): Record<string, unknown> {
  const html = sanitizeOutboundHtml(draft.bodyHtml);
  return buildDraftEmail({
    draftsMailboxId: draftsId,
    from: { name: identity.name || null, email: identity.email },
    to: parseRecipients(draft.to),
    cc: parseRecipients(draft.cc),
    bcc: parseRecipients(draft.bcc),
    subject: draft.subject,
    html,
    text: htmlToText(html),
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    // Spread to plain arrays: buildDraftEmail/attachmentParts/inlineAttachmentParts are pure (no
    // store proxy in). inlineAttachmentParts filters against `html` (the sanitized body), so an
    // image inserted then deleted — its cid no longer present — is dropped rather than sent orphaned.
    attachments: [...draft.attachments],
    inlineImages: [...draft.inlineImages],
  });
}

/**
 * Upload each picked file to the blob store and append it to the draft on success (so its blobId
 * rides the existing create — send/saveDraft need no extra round trip). Uploads run sequentially
 * and each is independent: a failed file is collected and reported by name without aborting the
 * rest, and a successful one is appended the instant it lands. {@link uploading} gates the submit
 * controls + the attach button for the duration (NOT discard — the generation guard makes a late
 * upload harmless, so the user isn't trapped). An auth failure raises the global re-auth gate.
 */
export async function attachFiles(files: File[]): Promise<void> {
  if (files.length === 0 || uploading()) return;
  const generation = draftGeneration;
  setUploading(true);
  setComposeError(null);
  const failed: string[] = [];
  try {
    const client = jmap();
    for (const file of files) {
      try {
        const result = await client.upload(file, file.type || "application/octet-stream");
        // The draft was discarded/reopened mid-upload — don't graft this onto a different draft.
        if (draftGeneration !== generation) return;
        // Content-addressed blob stores dedupe identical bytes to one blobId, so attaching the same
        // file twice would yield two chips with the same blobId — and removeAttachment(blobId) would
        // then drop both. Skip a blobId already attached; the bytes are present either way. The
        // functional update reads the live array, so a chip lands as each upload resolves, and the
        // server-recorded type/size are authoritative over the client-side File metadata.
        const { blobId, type, size } = result;
        setDraft("attachments", (prev) =>
          prev.some((a) => a.blobId === blobId)
            ? prev
            : [...prev, { blobId, type, name: file.name, size }],
        );
      } catch (err) {
        if (handleAuthFailure(err)) return;
        failed.push(file.name);
      }
    }
    if (failed.length > 0) {
      setComposeError(`Couldn't attach: ${failed.join(", ")}`);
    }
  } catch (err) {
    // jmap() can throw (e.g. disconnected after sign-out). This is a fire-and-forget call from the
    // UI, so surface the failure rather than leaving an unhandled rejection.
    if (!handleAuthFailure(err)) {
      setComposeError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    // Only this invocation's own draft generation may clear the flag — a stale invocation (whose
    // draft was already superseded) must not stomp a newer attachFiles' uploading state.
    if (draftGeneration === generation) setUploading(false);
  }
}

/** Drop an uploaded attachment from the draft by its blobId (the chip's remove control). */
export function removeAttachment(blobId: string): void {
  setDraft("attachments", (prev) => prev.filter((a) => a.blobId !== blobId));
}

/**
 * Upload one inline image and register it on the draft, returning the `cid:<cid>` URL the editor
 * inserts as an `<img src>` (or null on failure/skip). Like {@link attachFiles} it rides the existing
 * blob transport, guards against grafting a late upload onto a superseded draft (the generation
 * check), and toggles {@link uploading} so send/save wait it out — an in-flight inline upload must
 * not be left out of the create. A repeat of the same bytes (a content-addressed store returns one
 * blobId) reuses the existing cid so the body can reference one part rather than emitting two. The
 * cid is a UUID under a `.invalid` domain (RFC 6761) — it never resolves on the network, it's only a
 * within-message part label. Refuses while another upload is in flight (matching attach), returning
 * null so nothing is inserted.
 */
export async function insertInlineImage(file: File): Promise<string | null> {
  if (uploading()) return null;
  const generation = draftGeneration;
  setUploading(true);
  setComposeError(null);
  try {
    const client = jmap();
    const { blobId, type, size } = await client.upload(
      file,
      file.type || "application/octet-stream",
    );
    // The draft was discarded/reopened mid-upload — don't graft this onto a different draft.
    if (draftGeneration !== generation) return null;
    const existing = draft.inlineImages.find((i) => i.blobId === blobId);
    if (existing) return `cid:${existing.cid}`;
    const cid = `${crypto.randomUUID()}@qelo.invalid`;
    setDraft("inlineImages", (prev) => [
      ...prev,
      { cid, blobId, type, name: file.name || null, size },
    ]);
    return `cid:${cid}`;
  } catch (err) {
    if (handleAuthFailure(err)) return null;
    setComposeError(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    if (draftGeneration === generation) setUploading(false);
  }
}

/**
 * Save the current message to Drafts (`Email/set create` with `$draft`). Resolves to true on
 * success (and closes the composer — the push drain surfaces the new Drafts row), false on a
 * refusal/failure, which is surfaced via {@link composeError}. Never rejects.
 */
export async function saveDraft(): Promise<boolean> {
  // Refuse while a submit is in flight or an upload is still resolving — saving mid-upload would
  // race the attachment append and persist a draft missing a blobId. The UI also gates the button.
  if (busy() || uploading()) return false;
  const draftsId = mailboxIdByRole("drafts");
  if (!draftsId) {
    setComposeError("No Drafts folder to save into.");
    return false;
  }
  const identity = selectedIdentity();
  if (!identity) {
    setComposeError("No sending identity available.");
    return false;
  }
  // A draft may be recipient-less, but it must not silently DROP a mistyped one.
  const invalid = invalidDraftRecipients();
  if (invalid.length > 0) {
    setComposeError(`Fix or remove these addresses: ${invalid.join(", ")}`);
    return false;
  }
  setBusy("save");
  setComposeError(null);
  try {
    const client = jmap();
    const responses = await client.request([
      emailSet(client.accountId, "draft", {
        create: { draft: currentDraftCreate(draftsId, identity) },
      }),
    ]);
    const failure = setResult(responses, "draft").notCreated.draft;
    if (failure) {
      setComposeError(`Couldn't save draft: ${failure.description ?? failure.type}`);
      return false;
    }
    notify("Draft saved");
    closeAndReset();
    return true;
  } catch (err) {
    if (handleAuthFailure(err)) return false;
    setComposeError(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    setBusy(null);
  }
}

/**
 * Send the current message — the one batched round trip (D3 / Key JMAP mechanics §6):
 * `Email/set{create #draft}` + `EmailSubmission/set{create, onSuccessUpdateEmail}`, where the
 * submission references the just-created draft by creation id and, on success, the server files
 * the message Drafts→Sent ($draft cleared, $seen set) in the same request. Resolves true on a
 * sent message (composer closes; the push drain surfaces the Sent + delivered Inbox copies),
 * false on a validation/refusal/failure surfaced via {@link composeError}. Never rejects.
 */
export async function send(): Promise<boolean> {
  // As with saveDraft: don't send mid-upload (would submit a message missing an attachment blob).
  if (busy() || uploading()) return false;
  const draftsId = mailboxIdByRole("drafts");
  if (!draftsId) {
    setComposeError("No Drafts folder to send from.");
    return false;
  }
  const identity = selectedIdentity();
  if (!identity) {
    setComposeError("No sending identity available.");
    return false;
  }
  // Reject a mistyped recipient rather than silently sending to only the valid subset.
  const invalid = invalidDraftRecipients();
  if (invalid.length > 0) {
    setComposeError(`Fix or remove these addresses: ${invalid.join(", ")}`);
    return false;
  }
  // At least one recipient across to/cc/bcc, else there is nothing to submit to.
  if (!parseRecipients(draft.to) && !parseRecipients(draft.cc) && !parseRecipients(draft.bcc)) {
    setComposeError("Add at least one recipient.");
    return false;
  }
  // Fail fast if this account can't submit (e.g. a read-only token), rather than building a send
  // the server will reject with a confusing error. Email/set + EmailSubmission/set share this one
  // account by JMAP design, so the same accountId serves both.
  if (!jmap().accountHasCapability(CAP_SUBMISSION)) {
    setComposeError(NO_SUBMISSION_MESSAGE);
    return false;
  }
  setBusy("send");
  setComposeError(null);
  try {
    const client = jmap();
    const sentId = mailboxIdByRole("sent");
    const responses = await client.request(
      [
        emailSet(client.accountId, "draft", {
          create: { draft: currentDraftCreate(draftsId, identity) },
        }),
        emailSubmissionSet(client.accountId, "sub", {
          create: { sub: { identityId: identity.id, emailId: "#draft" } },
          onSuccessUpdateEmail: { "#sub": sentFilePatch(draftsId, sentId) },
        }),
      ],
      [CAP_CORE, CAP_MAIL, CAP_SUBMISSION],
    );
    // The draft must have been created for the submission to reference it.
    const draftFailure = setResult(responses, "draft").notCreated.draft;
    if (draftFailure) {
      setComposeError(
        `Couldn't create the message: ${draftFailure.description ?? draftFailure.type}`,
      );
      return false;
    }
    // setResult matches the FIRST "sub" response — the EmailSubmission/set itself, not the
    // implicit onSuccessUpdateEmail Email/set that rides under the same call id.
    const subFailure = setResult<EmailSubmission>(responses, "sub").notCreated.sub;
    if (subFailure) {
      // The draft exists in Drafts but wasn't sent — say so rather than implying it vanished.
      setComposeError(
        `Couldn't send (saved to Drafts): ${subFailure.description ?? subFailure.type}`,
      );
      return false;
    }
    notify("Message sent");
    closeAndReset();
    return true;
  } catch (err) {
    if (handleAuthFailure(err)) return false;
    setComposeError(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    setBusy(null);
  }
}
