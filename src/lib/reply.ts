// Pure builders for reply / reply-all / forward prefill (PR 4). Plain-text only (D3): the quoted
// body is plain-text quoting with "> " line prefixes, not HTML. No SolidJS, no JMAP client — just
// Email → derived recipients / subject / quoted body / threading headers, so it's unit-tested in
// isolation alongside the other lib helpers.

import type { Email, EmailAddress } from "@/jmap/types";
import { formatDateTime, recipientList, senderName } from "./format";

// The fields a reply/forward actually reads off the source message — a narrow slice so the
// builders (and their tests) don't need to construct a whole Email.
type ReplySource = Pick<
  Email,
  | "from"
  | "to"
  | "cc"
  | "replyTo"
  | "subject"
  | "receivedAt"
  | "messageId"
  | "references"
  | "textBody"
  | "bodyValues"
  | "preview"
>;

// --- Subject prefixes ------------------------------------------------------

// A leading "Re:" / "Fwd:" already on the subject, case-insensitively and tolerant of extra
// whitespace, so we don't stack "Re: Re: …". Only the immediate leading prefix is collapsed
// (matching common mail clients) — an embedded one mid-subject is left alone.
const RE_PREFIX = /^\s*re\s*:/i;
const FWD_PREFIX = /^\s*fwd?\s*:/i; // matches "Fwd:" and the common "Fw:" variant

/** "Re: <subject>", without double-prefixing a subject that already starts with "Re:". */
export function replySubject(subject: string | null): string {
  const base = subject ?? "";
  return RE_PREFIX.test(base) ? base.trimStart() : `Re: ${base}`;
}

/** "Fwd: <subject>", without double-prefixing a subject that already starts with "Fwd:"/"Fw:". */
export function forwardSubject(subject: string | null): string {
  const base = subject ?? "";
  return FWD_PREFIX.test(base) ? base.trimStart() : `Fwd: ${base}`;
}

// --- Recipients ------------------------------------------------------------

export interface ReplyRecipients {
  /** Bare email addresses for the To field (the original sender / Reply-To). */
  to: string[];
  /** Bare email addresses for the Cc field (reply-all only; empty for a plain reply). */
  cc: string[];
}

/**
 * Append each address's email to `out`, skipping blanks, anything whose lowercased form is in
 * `seen`, and intra-list duplicates. `seen` is mutated so a later call (Cc after To) won't repeat
 * an address already placed. Display names are intentionally dropped — plain-text compose v1 takes
 * bare addresses (consistent with `parseRecipients`).
 */
function collectEmails(
  addresses: EmailAddress[] | null | undefined,
  out: string[],
  seen: Set<string>,
): void {
  for (const addr of addresses ?? []) {
    const email = addr.email.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
}

/**
 * Derive the recipients of a reply. To = the message's `replyTo` (falling back to `from`). For a
 * reply-all, Cc additionally gathers the original `to` + `cc`, minus the user's own identity
 * addresses (`self`) and anything already in To, deduped case-insensitively. The To set is NOT
 * self-filtered — replying to a message you yourself sent is legitimate.
 */
export function replyRecipients(
  email: Pick<ReplySource, "from" | "to" | "cc" | "replyTo">,
  opts: { all: boolean; self: string[] },
): ReplyRecipients {
  const placed = new Set<string>();
  const to: string[] = [];
  collectEmails(email.replyTo ?? email.from, to, placed);
  if (!opts.all) return { to, cc: [] };

  // Reply-all: everyone else on the thread. Seed the exclusion set with the user's own
  // addresses (so we don't Cc ourselves) on top of whoever's already in To.
  for (const own of opts.self) {
    const key = own.trim().toLowerCase();
    if (key) placed.add(key);
  }
  const cc: string[] = [];
  collectEmails(email.to, cc, placed);
  collectEmails(email.cc, cc, placed);
  return { to, cc };
}

// --- Threading headers -----------------------------------------------------

export interface ThreadingHeaders {
  inReplyTo: string[] | null;
  references: string[] | null;
}

/**
 * The RFC 5322 / JMAP threading headers that keep a reply in the source's thread:
 * `inReplyTo` = the source's `messageId`, `references` = the source's `references` chain with the
 * source's `messageId` appended. A source with no `messageId` yields nulls (nothing to thread on),
 * so `buildDraftEmail` omits the fields entirely.
 */
export function threadingHeaders(
  email: Pick<ReplySource, "messageId" | "references">,
): ThreadingHeaders {
  // A well-formed message has exactly one Message-ID, and In-Reply-To references that single
  // parent id (RFC 5322 §3.6.4). Take the first even if a malformed source parsed to several,
  // rather than leaking extra ids into In-Reply-To/References.
  const parent = email.messageId?.[0];
  if (!parent) return { inReplyTo: null, references: null };
  return {
    inReplyTo: [parent],
    references: [...(email.references ?? []), parent],
  };
}

// --- Quoted bodies ---------------------------------------------------------

/**
 * The plain-text body to quote. Prefers the fetched `text/plain` part; when the message is
 * HTML-only (no plain part fetched) it falls back to the server's `preview` snippet rather than
 * down-converting HTML — full HTML→text is out of scope for plain-text compose v1.
 */
export function plainTextBody(
  email: Pick<ReplySource, "textBody" | "bodyValues" | "preview">,
): string {
  // Quote the text/plain part specifically. For an HTML-only message the server lists the
  // text/html part in textBody (there's no plain part), so guard on the type — quoting raw
  // markup with "> " prefixes would be worse than the preview fallback.
  const part = email.textBody?.[0];
  if (part?.partId && part.type === "text/plain") {
    const value = email.bodyValues?.[part.partId]?.value;
    if (value !== undefined) return value;
  }
  return email.preview ?? "";
}

/** Prefix every line of `text` with "> " (a bare ">" for blank lines), the usual reply quote. */
function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * A reply body: a blank line for the user to type into, an attribution line
 * ("On <date>, <sender> wrote:"), and the source body quoted with "> " prefixes.
 */
export function replyQuote(email: ReplySource): string {
  const attribution = `On ${formatDateTime(email.receivedAt)}, ${senderName(email.from)} wrote:`;
  return `\n\n${attribution}\n${quoteLines(plainTextBody(email))}\n`;
}

/**
 * A forward body: a "Forwarded message" header block (From/Date/Subject/To) followed by the
 * source body verbatim (a forward presents the original, it doesn't quote it as a reply does).
 */
export function forwardQuote(email: ReplySource): string {
  const lines = [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${senderName(email.from)}`,
    `Date: ${formatDateTime(email.receivedAt)}`,
    `Subject: ${email.subject ?? ""}`,
    `To: ${recipientList(email.to)}`,
    "",
    plainTextBody(email),
  ];
  return lines.join("\n");
}
