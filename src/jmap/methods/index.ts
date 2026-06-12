// Typed builders for the JMAP method calls Qelo issues, plus the helpers for
// chaining them via result references. Each builder returns a [name, args, callId]
// tuple (a MethodCall); several can be batched into one JmapClient.request().
//
// Pure protocol — no SolidJS, no UI. Field names follow RFC 8620/8621 exactly.

import type { Id, MethodCall, MethodResponse } from "../types";

export const CAP_CORE = "urn:ietf:params:jmap:core";
export const CAP_MAIL = "urn:ietf:params:jmap:mail";

/** Properties needed to render a row in the conversation list. */
export const LIST_PROPERTIES = [
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "subject",
  "receivedAt",
  "preview",
  "hasAttachment",
  "size",
] as const;

/** List properties plus the full headers and body needed by the reading pane. */
export const DETAIL_PROPERTIES = [
  ...LIST_PROPERTIES,
  "cc",
  "bcc",
  "replyTo",
  "sentAt",
  "messageId",
  "inReplyTo",
  "references",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
] as const;

/**
 * A JMAP result reference: lets one method consume an earlier method's output within
 * the same request (RFC 8620 §3.7). Placed in args under a `#`-prefixed key.
 */
export interface ResultReference {
  resultOf: string; // call id of the referenced method
  name: string; // method name of the referenced method
  path: string; // JSON pointer into that method's response
}

/** Reference the `/ids` of an earlier Email/query — the canonical query→get chain. */
export function idsFromQuery(queryCallId: string): ResultReference {
  return { resultOf: queryCallId, name: "Email/query", path: "/ids" };
}

/**
 * A `/get` must target records by literal `ids` or a `#ids` back-reference — exactly
 * one. Requiring it at the type level prevents an accidental "fetch everything" call
 * (omitting both would send `ids: null`, i.e. the entire account) for Email/Thread.
 */
export type IdsSelector = { ids: Id[]; idsRef?: never } | { idsRef: ResultReference; ids?: never };

function idsArgs(sel: IdsSelector): Record<string, unknown> {
  return sel.idsRef ? { "#ids": sel.idsRef } : { ids: sel.ids };
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

export function mailboxGet(
  accountId: Id,
  callId: string,
  opts: { ids?: Id[] | null; properties?: readonly string[] } = {},
): MethodCall {
  const args: Record<string, unknown> = { accountId, ids: opts.ids ?? null };
  if (opts.properties) args.properties = opts.properties;
  return ["Mailbox/get", args, callId];
}

export function mailboxChanges(accountId: Id, sinceState: string, callId: string): MethodCall {
  return ["Mailbox/changes", { accountId, sinceState }, callId];
}

// ---------------------------------------------------------------------------
// Email query (windowed, thread-collapsed)
// ---------------------------------------------------------------------------

export interface EmailQueryOptions {
  /** Shorthand for `filter: { inMailbox: mailboxId }`. Ignored if `filter` is set. */
  mailboxId?: Id;
  filter?: Record<string, unknown>;
  /** Defaults to newest-first by receivedAt. */
  sort?: ReadonlyArray<{ property: string; isAscending?: boolean }>;
  collapseThreads?: boolean;
  position?: number;
  limit?: number;
  anchor?: Id;
  anchorOffset?: number;
  calculateTotal?: boolean;
}

// filter + sort are shared by Email/query and Email/queryChanges, and queryChanges
// requires them to match the original query — so build them in one place.
function filterSortArgs(opts: EmailQueryOptions): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const filter = opts.filter ?? (opts.mailboxId ? { inMailbox: opts.mailboxId } : undefined);
  if (filter) args.filter = filter;
  args.sort = opts.sort ?? [{ property: "receivedAt", isAscending: false }];
  return args;
}

export function emailQuery(
  accountId: Id,
  callId: string,
  opts: EmailQueryOptions = {},
): MethodCall {
  const args: Record<string, unknown> = { accountId, ...filterSortArgs(opts) };
  if (opts.collapseThreads !== undefined) args.collapseThreads = opts.collapseThreads;
  if (opts.position !== undefined) args.position = opts.position;
  if (opts.limit !== undefined) args.limit = opts.limit;
  if (opts.anchor !== undefined) args.anchor = opts.anchor;
  if (opts.anchorOffset !== undefined) args.anchorOffset = opts.anchorOffset;
  if (opts.calculateTotal !== undefined) args.calculateTotal = opts.calculateTotal;
  return ["Email/query", args, callId];
}

// Email/queryChanges has no `limit`/`position`/`anchor` (RFC 8620 §5.6); it bounds
// results with `maxChanges`/`upToId` instead.
export interface EmailQueryChangesOptions
  extends Omit<EmailQueryOptions, "position" | "anchor" | "anchorOffset" | "limit"> {
  maxChanges?: number;
  upToId?: Id;
}

export function emailQueryChanges(
  accountId: Id,
  sinceQueryState: string,
  callId: string,
  opts: EmailQueryChangesOptions = {},
): MethodCall {
  const args: Record<string, unknown> = { accountId, sinceQueryState, ...filterSortArgs(opts) };
  if (opts.collapseThreads !== undefined) args.collapseThreads = opts.collapseThreads;
  if (opts.calculateTotal !== undefined) args.calculateTotal = opts.calculateTotal;
  if (opts.maxChanges !== undefined) args.maxChanges = opts.maxChanges;
  if (opts.upToId !== undefined) args.upToId = opts.upToId;
  return ["Email/queryChanges", args, callId];
}

// ---------------------------------------------------------------------------
// Email get
// ---------------------------------------------------------------------------

export type EmailGetOptions = IdsSelector & {
  properties?: readonly string[];
  bodyProperties?: readonly string[];
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
};

export function emailGet(accountId: Id, callId: string, opts: EmailGetOptions): MethodCall {
  const args: Record<string, unknown> = { accountId, ...idsArgs(opts) };
  if (opts.properties) args.properties = opts.properties;
  if (opts.bodyProperties) args.bodyProperties = opts.bodyProperties;
  if (opts.fetchTextBodyValues !== undefined) args.fetchTextBodyValues = opts.fetchTextBodyValues;
  if (opts.fetchHTMLBodyValues !== undefined) args.fetchHTMLBodyValues = opts.fetchHTMLBodyValues;
  if (opts.fetchAllBodyValues !== undefined) args.fetchAllBodyValues = opts.fetchAllBodyValues;
  return ["Email/get", args, callId];
}

export function emailChanges(
  accountId: Id,
  sinceState: string,
  callId: string,
  maxChanges?: number,
): MethodCall {
  const args: Record<string, unknown> = { accountId, sinceState };
  if (maxChanges !== undefined) args.maxChanges = maxChanges;
  return ["Email/changes", args, callId];
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export function threadGet(accountId: Id, callId: string, opts: IdsSelector): MethodCall {
  return ["Thread/get", { accountId, ...idsArgs(opts) }, callId];
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * A method-level JMAP error response (RFC 8620 §3.6.2): the request succeeded at the
 * transport level but one method returned `["error", { type, ... }, callId]`. Carries
 * the `type` so callers can branch on it (e.g. `anchorNotFound`, `cannotCalculateChanges`)
 * instead of string-matching the message.
 */
export class JmapMethodError extends Error {
  constructor(
    readonly type: string,
    readonly callId: string,
    readonly args: Record<string, unknown>,
  ) {
    super(`JMAP error for "${callId}": ${JSON.stringify(args)}`);
    this.name = "JmapMethodError";
  }
}

/**
 * Find the response for a given call id and return its args, throwing a
 * {@link JmapMethodError} on a method-level "error" response (e.g. invalidArguments,
 * unknownMethod).
 *
 * NOTE: this does NOT inspect `/set` per-item failures (notCreated/notUpdated/
 * notDestroyed) — those ride on an otherwise-successful response, so a caller issuing
 * a `/set` must check those maps itself (see dev/stalwart/seed.mjs for the pattern).
 */
export function methodResult(responses: MethodResponse[], callId: string): Record<string, unknown> {
  const found = responses.find((r) => r[2] === callId);
  if (!found) throw new Error(`No JMAP response for call id "${callId}"`);
  if (found[0] === "error") {
    const args = found[1];
    const type = typeof args.type === "string" ? args.type : "unknown";
    throw new JmapMethodError(type, callId, args);
  }
  return found[1];
}
