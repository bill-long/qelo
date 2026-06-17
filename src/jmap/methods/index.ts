// Typed builders for the JMAP method calls Qelo issues, plus the helpers for
// chaining them via result references. Each builder returns a [name, args, callId]
// tuple (a MethodCall); several can be batched into one JmapClient.request().
//
// Pure protocol — no SolidJS, no UI. Field names follow RFC 8620/8621 exactly.

import type { Email, EmailSetResponse, Id, MethodCall, MethodResponse, SetError } from "../types";

export const CAP_CORE = "urn:ietf:params:jmap:core";
export const CAP_MAIL = "urn:ietf:params:jmap:mail";
// Identity and EmailSubmission both live under the submission capability, so any request
// touching them must add this to `using` (the default `request()` `using` is [core, mail]).
export const CAP_SUBMISSION = "urn:ietf:params:jmap:submission";
// AddressBook and ContactCard live under the contacts capability; a request touching them
// must add this to `using`. The contacts account is `primaryAccounts[CAP_CONTACTS]` (== the
// mail account on the dev server, but resolve it explicitly rather than assuming).
export const CAP_CONTACTS = "urn:ietf:params:jmap:contacts";
// Calendar and CalendarEvent live under the calendars capability; a request touching them
// must add this to `using`. The calendar account is `primaryAccounts[CAP_CALENDARS]` (== the
// mail account on the dev server, but resolve it explicitly rather than assuming).
export const CAP_CALENDARS = "urn:ietf:params:jmap:calendars";

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
// Email set (mutations)
// ---------------------------------------------------------------------------

/**
 * A single record's patch for `Email/set update`. Keys are JSON pointers into the Email
 * (RFC 8620 §5.3) — e.g. `"keywords/$seen"`, `"mailboxIds/<id>"` — set to the new value
 * or `null` to remove that pointer. Build them with the typed helpers below rather than
 * writing pointer strings by hand so a caller can't typo `keyword/` or `keywords$seen`.
 */
export type EmailPatch = Record<string, unknown>;

export interface EmailSetOptions {
  /** Creation-id → new-record map; the ids become `#creationId` back-references. */
  create?: Record<string, Record<string, unknown>>;
  /** Existing-id → patch map (JSON-pointer keys; see {@link EmailPatch}). */
  update?: Record<Id, EmailPatch>;
  destroy?: Id[];
}

export function emailSet(accountId: Id, callId: string, opts: EmailSetOptions): MethodCall {
  const args: Record<string, unknown> = { accountId };
  if (opts.create) args.create = opts.create;
  if (opts.update) args.update = opts.update;
  if (opts.destroy) args.destroy = opts.destroy;
  return ["Email/set", args, callId];
}

/** Patch that sets a keyword, e.g. `setKeyword("$seen")` → `{"keywords/$seen": true}`. */
export function setKeyword(keyword: string): EmailPatch {
  return { [`keywords/${keyword}`]: true };
}

/** Patch that removes a keyword, e.g. `clearKeyword("$seen")` → `{"keywords/$seen": null}`. */
export function clearKeyword(keyword: string): EmailPatch {
  return { [`keywords/${keyword}`]: null };
}

/** Set or clear a keyword by boolean — the toggle form the keyword store actions use. */
export function keywordPatch(keyword: string, on: boolean): EmailPatch {
  return on ? setKeyword(keyword) : clearKeyword(keyword);
}

/**
 * Patch that moves an email between mailboxes: removes the `from` mailbox and adds the `to`
 * one in a single `Email/set update` — `{"mailboxIds/<from>": null, "mailboxIds/<to>": true}`.
 * `mailboxIds` is a presence map exactly like `keywords`, so a move is just two pointer ops on
 * it. (The optimistic store path builds the same shape from its presence patches; this is the
 * standalone wire-shape helper, parallel to the keyword helpers.)
 */
export function movePatch(fromId: Id, toId: Id): EmailPatch {
  return { [`mailboxIds/${fromId}`]: null, [`mailboxIds/${toId}`]: true };
}

// ---------------------------------------------------------------------------
// Identity (RFC 8621 §6) — the sending addresses compose can pick from
// ---------------------------------------------------------------------------

/** Fetch the account's sending identities; `ids: null` (the default) returns them all. */
export function identityGet(accountId: Id, callId: string, ids: Id[] | null = null): MethodCall {
  return ["Identity/get", { accountId, ids }, callId];
}

// ---------------------------------------------------------------------------
// EmailSubmission (RFC 8621 §7) — the send itself
// ---------------------------------------------------------------------------

export interface EmailSubmissionSetOptions {
  /** Creation-id → submission map, e.g. `{ sub: { identityId, emailId: "#draft" } }`. */
  create?: Record<string, Record<string, unknown>>;
  /**
   * Per just-created submission, a patch to apply to its email iff the submission succeeds
   * (RFC 8621 §7.5) — keyed by the submission's `#creationId`. The headline use: atomically
   * clear `$draft`, set `$seen`, and move the message Drafts→Sent the instant the send lands,
   * in the same round trip. The server runs it as an implicit `Email/set` whose response rides
   * under this method's call id.
   */
  onSuccessUpdateEmail?: Record<string, EmailPatch>;
  /** Per just-created submission, destroy its email on success instead (we keep the Sent copy). */
  onSuccessDestroyEmail?: string[];
}

export function emailSubmissionSet(
  accountId: Id,
  callId: string,
  opts: EmailSubmissionSetOptions,
): MethodCall {
  const args: Record<string, unknown> = { accountId };
  if (opts.create) args.create = opts.create;
  if (opts.onSuccessUpdateEmail) args.onSuccessUpdateEmail = opts.onSuccessUpdateEmail;
  if (opts.onSuccessDestroyEmail) args.onSuccessDestroyEmail = opts.onSuccessDestroyEmail;
  return ["EmailSubmission/set", args, callId];
}

// ---------------------------------------------------------------------------
// Contacts — AddressBook + ContactCard (JMAP for Contacts / JSContact RFC 9553)
// ---------------------------------------------------------------------------

export function addressBookGet(
  accountId: Id,
  callId: string,
  opts: { ids?: Id[] | null; properties?: readonly string[] } = {},
): MethodCall {
  const args: Record<string, unknown> = { accountId, ids: opts.ids ?? null };
  if (opts.properties) args.properties = opts.properties;
  return ["AddressBook/get", args, callId];
}

export function addressBookChanges(accountId: Id, sinceState: string, callId: string): MethodCall {
  return ["AddressBook/changes", { accountId, sinceState }, callId];
}

/** Reference the `/ids` of an earlier ContactCard/query — the query→get chain for cards. */
export function idsFromContactQuery(queryCallId: string): ResultReference {
  return { resultOf: queryCallId, name: "ContactCard/query", path: "/ids" };
}

export interface ContactCardQueryOptions {
  filter?: Record<string, unknown>;
  // Stalwart v0.16 rejects every ContactCard sort property we tried (`unsupportedSort` on
  // `name`/`name/full`), so Qelo sorts cards client-side (lib/contacts.ts compareContacts) and
  // omits `sort` here by default. The arg is kept for a server that does support it.
  sort?: ReadonlyArray<{ property: string; isAscending?: boolean }>;
  position?: number;
  limit?: number;
  anchor?: Id;
  anchorOffset?: number;
  calculateTotal?: boolean;
}

export function contactCardQuery(
  accountId: Id,
  callId: string,
  opts: ContactCardQueryOptions = {},
): MethodCall {
  const args: Record<string, unknown> = { accountId };
  if (opts.filter) args.filter = opts.filter;
  if (opts.sort) args.sort = opts.sort;
  if (opts.position !== undefined) args.position = opts.position;
  if (opts.limit !== undefined) args.limit = opts.limit;
  if (opts.anchor !== undefined) args.anchor = opts.anchor;
  if (opts.anchorOffset !== undefined) args.anchorOffset = opts.anchorOffset;
  if (opts.calculateTotal !== undefined) args.calculateTotal = opts.calculateTotal;
  return ["ContactCard/query", args, callId];
}

export type ContactCardGetOptions = IdsSelector & { properties?: readonly string[] };

export function contactCardGet(
  accountId: Id,
  callId: string,
  opts: ContactCardGetOptions,
): MethodCall {
  const args: Record<string, unknown> = { accountId, ...idsArgs(opts) };
  // Omitting `properties` returns the whole card — the read-only detail wants every populated
  // field, and a card is small, so Qelo fetches full cards rather than a list/detail split.
  if (opts.properties) args.properties = opts.properties;
  return ["ContactCard/get", args, callId];
}

export function contactCardChanges(
  accountId: Id,
  sinceState: string,
  callId: string,
  maxChanges?: number,
): MethodCall {
  const args: Record<string, unknown> = { accountId, sinceState };
  if (maxChanges !== undefined) args.maxChanges = maxChanges;
  return ["ContactCard/changes", args, callId];
}

/**
 * A single card's patch for `ContactCard/set update`. Keys are JSON pointers into the JSContact
 * Card (RFC 8620 §5.3) — a whole-property pointer (`"emails"`, `"name"`) replaces that property,
 * a leaf pointer (`"name/full"`, `"emails/<key>/address"`) sets one value, and `null` removes the
 * pointed-at value. Unlike Email (immutable content — a "edit" is create+destroy), a ContactCard
 * is a normal mutable JMAP object, so an in-place patch is the edit path. Qelo builds these with
 * whole-property pointers (carrying un-edited sub-fields through), so a patch never clobbers a
 * property — like `photos`/`kind` — the form doesn't expose. Verified live against dev Stalwart:
 * whole-property replace, leaf set, and `null` removal all round-trip and leave un-named
 * properties untouched.
 */
export type ContactCardPatch = Record<string, unknown>;

export interface ContactCardSetOptions {
  /** Creation-id → new-card map; the ids become `#creationId` back-references. (Phase 2 create.) */
  create?: Record<string, Record<string, unknown>>;
  /** Existing-id → patch map (JSON-pointer keys; see {@link ContactCardPatch}). */
  update?: Record<Id, ContactCardPatch>;
  destroy?: Id[];
}

export function contactCardSet(
  accountId: Id,
  callId: string,
  opts: ContactCardSetOptions,
): MethodCall {
  const args: Record<string, unknown> = { accountId };
  if (opts.create) args.create = opts.create;
  if (opts.update) args.update = opts.update;
  if (opts.destroy) args.destroy = opts.destroy;
  return ["ContactCard/set", args, callId];
}

// ---------------------------------------------------------------------------
// Calendar — Calendar + CalendarEvent (JMAP for Calendars / JSCalendar RFC 8984)
// ---------------------------------------------------------------------------

export function calendarGet(
  accountId: Id,
  callId: string,
  opts: { ids?: Id[] | null; properties?: readonly string[] } = {},
): MethodCall {
  const args: Record<string, unknown> = { accountId, ids: opts.ids ?? null };
  if (opts.properties) args.properties = opts.properties;
  return ["Calendar/get", args, callId];
}

export function calendarChanges(accountId: Id, sinceState: string, callId: string): MethodCall {
  return ["Calendar/changes", { accountId, sinceState }, callId];
}

/** Reference the `/ids` of an earlier CalendarEvent/query — the query→get chain for events. */
export function idsFromCalendarEventQuery(queryCallId: string): ResultReference {
  return { resultOf: queryCallId, name: "CalendarEvent/query", path: "/ids" };
}

export interface CalendarEventQueryOptions {
  /** Filter — Qelo's agenda passes `{ after, before }` (a UTC date-time window); both work live. */
  filter?: Record<string, unknown>;
  /** Default sort is by `start` ascending — confirmed sortable on Stalwart (`created`/`updated` are not). */
  sort?: ReadonlyArray<{ property: string; isAscending?: boolean }>;
  /**
   * Expand recurring events into one synthetic per-occurrence id within the filter window
   * (RFC 8620 §5.5 / RFC 8984): a `CalendarEvent/get` on those ids resolves each to the
   * occurrence's own `start` + `recurrenceId`. The agenda relies on this — no client-side
   * recurrence math. Bounded by `accountCapabilities.maxExpandedQueryDuration`.
   */
  expandRecurrences?: boolean;
  position?: number;
  limit?: number;
  anchor?: Id;
  anchorOffset?: number;
  calculateTotal?: boolean;
}

export function calendarEventQuery(
  accountId: Id,
  callId: string,
  opts: CalendarEventQueryOptions = {},
): MethodCall {
  const args: Record<string, unknown> = { accountId };
  if (opts.filter) args.filter = opts.filter;
  args.sort = opts.sort ?? [{ property: "start", isAscending: true }];
  if (opts.expandRecurrences !== undefined) args.expandRecurrences = opts.expandRecurrences;
  if (opts.position !== undefined) args.position = opts.position;
  if (opts.limit !== undefined) args.limit = opts.limit;
  if (opts.anchor !== undefined) args.anchor = opts.anchor;
  if (opts.anchorOffset !== undefined) args.anchorOffset = opts.anchorOffset;
  if (opts.calculateTotal !== undefined) args.calculateTotal = opts.calculateTotal;
  return ["CalendarEvent/query", args, callId];
}

export type CalendarEventGetOptions = IdsSelector & { properties?: readonly string[] };

export function calendarEventGet(
  accountId: Id,
  callId: string,
  opts: CalendarEventGetOptions,
): MethodCall {
  const args: Record<string, unknown> = { accountId, ...idsArgs(opts) };
  // Omitting `properties` returns the whole event — the read-only detail wants every populated
  // field, and an event is small, so Qelo fetches full events rather than a list/detail split.
  if (opts.properties) args.properties = opts.properties;
  return ["CalendarEvent/get", args, callId];
}

export function calendarEventChanges(
  accountId: Id,
  sinceState: string,
  callId: string,
  maxChanges?: number,
): MethodCall {
  const args: Record<string, unknown> = { accountId, sinceState };
  if (maxChanges !== undefined) args.maxChanges = maxChanges;
  return ["CalendarEvent/changes", args, callId];
}

/**
 * A single event's patch for `CalendarEvent/set update`. Keys are JSON pointers (the `/set update`
 * patch mechanism, RFC 8620 §5.3) into the JSCalendar Event (RFC 8984) — a whole-property pointer
 * (`"title"`, `"start"`, `"locations"`) replaces
 * that property, a leaf pointer (`"locations/<key>/name"`) sets one value, and `null` removes the
 * pointed-at value. A JSCalendar event is a normal mutable JMAP object (unlike Email, whose content
 * is immutable — an Email "edit" is create+destroy), so an in-place patch is the edit path. Qelo
 * builds these with whole-property pointers (carrying un-edited sub-fields through), so a patch never
 * clobbers a property the form doesn't expose — `recurrenceRule`, `participants`, `keywords`,
 * `color`, `uid`, `calendarIds`. Verified live against dev Stalwart: whole-property replace, a leaf
 * set, and `null` removal all round-trip and leave un-named properties (incl. `recurrenceRule`)
 * untouched. NOTE: updating an EXPANDED-occurrence synthetic id is rejected (`invalidProperties:
 * "Updating synthetic ids is not yet supported"`) — a caller must target the BASE event id.
 */
export type CalendarEventPatch = Record<string, unknown>;

export interface CalendarEventSetOptions {
  /** Creation-id → new-event map; the ids become `#creationId` back-references. (Phase 2 create.) */
  create?: Record<string, Record<string, unknown>>;
  /** Existing-id → patch map (JSON-pointer keys; see {@link CalendarEventPatch}). */
  update?: Record<Id, CalendarEventPatch>;
  destroy?: Id[];
}

export function calendarEventSet(
  accountId: Id,
  callId: string,
  opts: CalendarEventSetOptions,
): MethodCall {
  const args: Record<string, unknown> = { accountId };
  if (opts.create) args.create = opts.create;
  if (opts.update) args.update = opts.update;
  if (opts.destroy) args.destroy = opts.destroy;
  return ["CalendarEvent/set", args, callId];
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

/**
 * The per-record maps of an `Email/set` response, normalized so callers never null-check:
 * each map defaults to `{}` and `destroyed` to `[]`. Where `methodResult` throws on a
 * method-level error and otherwise hands back raw args, this surfaces the per-item failures
 * (`notCreated`/`notUpdated`/`notDestroyed`) that ride on an *otherwise-successful* `/set`
 * response — the maps a mutation must check to know which records the server actually refused.
 */
export interface SetResult<T = Email> {
  oldState: string | null;
  newState: string;
  created: Record<Id, Partial<T> | null>;
  updated: Record<Id, Partial<T> | null>;
  destroyed: Id[];
  notCreated: Record<Id, SetError>;
  notUpdated: Record<Id, SetError>;
  notDestroyed: Record<Id, SetError>;
}

/**
 * Parse a `/set` response into a typed {@link SetResult}. Generic over the record type so the
 * same helper serves `Email/set` (the default) and `EmailSubmission/set` — the wire shape is
 * identical (RFC 8620 §5.3); only the `created`/`updated` value type differs. Throws a
 * {@link JmapMethodError} on a method-level error (via `methodResult`); the per-item `not*`
 * maps are normalized to `{}` so a caller does `Object.keys(result.notUpdated)` without a guard.
 *
 * NOTE on `EmailSubmission/set` + `onSuccessUpdateEmail`: the server emits a SECOND response
 * (the implicit `Email/set`) under the SAME call id. `methodResult` matches the FIRST, i.e. the
 * EmailSubmission/set itself — exactly the result a caller wants to inspect for `notCreated`.
 *
 * `requireNewState` (default `true`) fails fast when the response omits the `newState` cursor
 * token, so a caller that PERSISTS it can't save an invalid cursor. Stalwart, however, omits
 * `newState` on an all-failed `/set` (every create/update/destroy refused — nothing changed, so
 * no new state). A caller that only inspects the `not*`/`destroyed`/`created` maps and never
 * advances a cursor from this `/set` (compose's send/save, the optimistic keyword/mailbox/destroy
 * mutations — all of which sync via `Email/changes`, not this token) must pass
 * `requireNewState: false`, or that strict check would throw before the refusal can be read.
 */
export function setResult<T = Email>(
  responses: MethodResponse[],
  callId: string,
  { requireNewState = true }: { requireNewState?: boolean } = {},
): SetResult<T> {
  // The raw args are the (Email|EmailSubmission)SetResponse wire shape (nullable maps). Partial<>
  // because an all-failed /set legitimately omits newState (and any map) — the typeof/?? guards below
  // handle the absent cases, so a non-Partial cast would falsely promise a required newState string.
  // SetResult is its normalized form. methodResult has already thrown on a method-level error.
  const args = methodResult(responses, callId) as unknown as Partial<EmailSetResponse>;
  const oldState = typeof args.oldState === "string" ? args.oldState : null;
  // newState is a required cursor token on a *state-changing* /set (RFC 8620 §5.3). A missing one
  // is fatal only for a caller that persists it (requireNewState); otherwise it just means an
  // all-failed /set (Stalwart omits it then) and we hand back oldState (or "") — never persisted.
  if (requireNewState && typeof args.newState !== "string") {
    throw new Error(`/set response for "${callId}" has no string newState`);
  }
  return {
    oldState,
    newState: typeof args.newState === "string" ? args.newState : (oldState ?? ""),
    created: (args.created ?? {}) as Record<Id, Partial<T> | null>,
    updated: (args.updated ?? {}) as Record<Id, Partial<T> | null>,
    destroyed: args.destroyed ?? [],
    notCreated: args.notCreated ?? {},
    notUpdated: args.notUpdated ?? {},
    notDestroyed: args.notDestroyed ?? {},
  };
}
