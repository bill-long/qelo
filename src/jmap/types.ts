// JMAP types per RFC 8620 (core) and RFC 8621 (mail).
// Only the subset Qelo needs initially.

export type Id = string;
export type UtcDate = string;

export interface Session {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

export interface Account {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: MailboxRole | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

export type MailboxRole =
  | "inbox"
  | "archive"
  | "drafts"
  | "sent"
  | "trash"
  | "junk"
  | "important"
  | "flagged"
  | "all"
  | "subscribed";

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface Email {
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: UtcDate;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: UtcDate | null;
  hasAttachment: boolean;
  preview: string;
  bodyValues?: Record<string, EmailBodyValue>;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
  attachments?: EmailBodyPart[];
}

export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  size: number;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  name: string | null;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export interface Thread {
  id: Id;
  emailIds: Id[];
}

/**
 * A per-record failure in a `/set` response (RFC 8620 §5.3). Rides on an otherwise-
 * successful method response in the `notCreated`/`notUpdated`/`notDestroyed` maps, so a
 * caller must inspect those maps itself — `methodResult` does not (see `setResult`). The
 * `type` distinguishes e.g. `forbidden` (rights), `notFound`, `invalidProperties`,
 * `stateMismatch`; `properties` names the offending fields for an `invalidProperties`.
 */
export interface SetError {
  type: string;
  description?: string | null;
  properties?: string[] | null;
}

/**
 * Response args of an `Email/set` (RFC 8620 §5.3, RFC 8621 §4.6). `created`/`updated`
 * carry only the server-set properties (or `null` when the server set nothing beyond
 * what was sent); `destroyed` lists the ids removed. The `not*` maps carry the per-record
 * {@link SetError}s for records the server refused. `oldState`/`newState` are the cursor
 * tokens — we do NOT advance our own `emailState` from them (the push-driven drain owns it).
 */
export interface EmailSetResponse {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<Id, Partial<Email> | null> | null;
  updated: Record<Id, Partial<Email> | null> | null;
  destroyed: Id[] | null;
  notCreated: Record<Id, SetError> | null;
  notUpdated: Record<Id, SetError> | null;
  notDestroyed: Record<Id, SetError> | null;
}

/**
 * A sending identity (RFC 8621 §6): the `from` an EmailSubmission may use. The seeded
 * account exposes one (`Test One <test@example.test>`); a real account may expose several
 * (aliases), so compose lets the user pick. Field names follow the RFC exactly.
 */
export interface Identity {
  id: Id;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

/**
 * One SMTP envelope address (RFC 8621 §7.1): the `email` plus any ESMTP `parameters`. The
 * envelope is optional on an `EmailSubmission` — when omitted the server derives it from the
 * message's `from`/`to`/`cc`/`bcc` (which is what Qelo relies on), so this is here to type the
 * `EmailSubmission.envelope` field rather than because compose sets it.
 */
export interface EmailSubmissionAddress {
  email: string;
  parameters: Record<string, string | null> | null;
}

/** The SMTP envelope of an EmailSubmission (RFC 8621 §7.1): a mail-from and the rcpt-tos. */
export interface Envelope {
  mailFrom: EmailSubmissionAddress;
  rcptTo: EmailSubmissionAddress[];
}

/**
 * An email send request (RFC 8621 §7). Created with `{ identityId, emailId }` referencing
 * the draft (here by a `#creationId` back-reference in the same batch); the server fills in
 * `threadId`/`envelope`/`sendAt`/`undoStatus`. Qelo only needs the subset it reads back.
 */
export interface EmailSubmission {
  id: Id;
  identityId: Id;
  emailId: Id;
  threadId: Id;
  envelope: Envelope | null;
  sendAt: UtcDate;
  undoStatus: "pending" | "final" | "canceled";
}

/**
 * Response of a blob upload to the session's `uploadUrl` (RFC 8620 §6.1). The server-assigned
 * `blobId` is what an `Email/set` create references in an attachment {@link EmailBodyPart}; `type`
 * and `size` are the values the server actually recorded for the stored blob (Qelo carries them
 * onto the attachment part rather than trusting the client-side file metadata). `accountId` echoes
 * the upload target. Upload rides the existing bearer transport — it is not a `/set` method call.
 */
export interface UploadResponse {
  accountId: Id;
  blobId: Id;
  type: string;
  size: number;
}

// ---------------------------------------------------------------------------
// Contacts — JMAP for Contacts + JSContact (RFC 9553). Field names follow the
// RFC exactly, same rule as the mail types. The dev Stalwart (v0.16) exposes
// `AddressBook`/`ContactCard` methods over `urn:ietf:params:jmap:contacts`; the
// card object is a JSContact `"@type":"Card"`. Most card sub-objects are id-keyed
// maps and most fields are optional — `noUncheckedIndexedAccess` already makes
// every map access `T | undefined`, so lean into that rather than over-asserting.
// ---------------------------------------------------------------------------

/** Per-AddressBook permissions (parallel to {@link MailboxRights}). */
export interface AddressBookRights {
  mayRead: boolean;
  mayWrite: boolean;
  mayDelete: boolean;
  mayShare: boolean;
}

/** A JMAP AddressBook: the container a {@link ContactCard} belongs to. */
export interface AddressBook {
  id: Id;
  name: string;
  description: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSubscribed: boolean;
  myRights: AddressBookRights;
}

/**
 * One component of a structured JSContact `name`/`address` (RFC 9553 §2.2.1/§2.5.1):
 * a `kind` (e.g. `given`/`surname` for names, `locality`/`region`/`country` for
 * addresses) and its `value`. Other components a server sends are typed loosely via
 * the open `kind` string rather than an exhaustive enum (the RFC reserves the set).
 */
export interface CardComponent {
  kind: string;
  value: string;
}

/** JSContact `Name` (RFC 9553 §2.2.1): the full string and/or ordered components. */
export interface CardName {
  full?: string;
  components?: CardComponent[];
  isOrdered?: boolean;
}

/**
 * The `contexts` map shared by many JSContact properties (RFC 9553 §1.5.1): keys like
 * `work`/`private`, each mapped to `true`. A presence map exactly like `keywords`.
 */
export type CardContexts = Record<string, true>;

/** JSContact `EmailAddress` (RFC 9553 §2.3.1). `pref` 1 = most preferred. */
export interface CardEmail {
  address: string;
  contexts?: CardContexts;
  pref?: number;
}

/** JSContact `Phone` (RFC 9553 §2.3.3). `features` keys e.g. `mobile`/`voice`/`fax`. */
export interface CardPhone {
  number: string;
  contexts?: CardContexts;
  features?: Record<string, true>;
  pref?: number;
}

/** JSContact `Address` (RFC 9553 §2.5.1): a postal address as full string and/or components. */
export interface CardAddress {
  full?: string;
  components?: CardComponent[];
  /** Whether `components` are in a meaningful order (RFC 9553 §2.5.1) — Stalwart sets it. */
  isOrdered?: boolean;
  contexts?: CardContexts;
  countryCode?: string;
  pref?: number;
}

/** JSContact `Organization` (RFC 9553 §2.2.3): a name and optional org units. */
export interface CardOrganization {
  name?: string;
  units?: Array<{ name: string }>;
}

/** JSContact `Title` (RFC 9553 §2.2.4): a job title or role. */
export interface CardTitle {
  name: string;
  kind?: string;
}

/** JSContact `OnlineService` (RFC 9553 §2.6.3): e.g. a social/IM handle. */
export interface CardOnlineService {
  service?: string;
  uri?: string;
  user?: string;
  contexts?: CardContexts;
}

/** JSContact `Note` (RFC 9553 §2.8.1): free-text note plus optional authorship. */
export interface CardNote {
  note: string;
  created?: UtcDate;
}

/**
 * A JSContact Card (RFC 9553) as returned by `ContactCard/get`. Only the subset Qelo
 * reads is fully typed; rarer properties (photos, anniversaries, relations, …) are left
 * out until a feature needs them rather than guessed. Sub-maps are id-keyed (the keys are
 * server-assigned strings, not meaningful) — iterate values, not keys.
 */
export interface ContactCard {
  "@type": "Card";
  version: string;
  id: Id;
  addressBookIds?: Record<Id, true>;
  kind?: string;
  name?: CardName;
  nicknames?: Record<string, { name: string }>;
  emails?: Record<string, CardEmail>;
  phones?: Record<string, CardPhone>;
  addresses?: Record<string, CardAddress>;
  organizations?: Record<string, CardOrganization>;
  titles?: Record<string, CardTitle>;
  onlineServices?: Record<string, CardOnlineService>;
  notes?: Record<string, CardNote>;
  updated?: UtcDate;
}

// ---------------------------------------------------------------------------
// Calendar — JMAP for Calendars + JSCalendar (RFC 8984). Field names follow the
// RFC exactly, same rule as the mail/contacts types. The dev Stalwart (v0.16)
// exposes `Calendar`/`CalendarEvent` methods over `urn:ietf:params:jmap:calendars`;
// the event object is a JSCalendar `"@type":"Event"`. Most event sub-objects are
// id-keyed maps and most fields are optional — `noUncheckedIndexedAccess` already
// makes every map access `T | undefined`, so lean into that.
// ---------------------------------------------------------------------------

/** Per-Calendar permissions (parallel to {@link MailboxRights}). */
export interface CalendarRights {
  mayReadFreeBusy: boolean;
  mayReadItems: boolean;
  mayWriteAll: boolean;
  mayWriteOwn: boolean;
  mayUpdatePrivate: boolean;
  mayRSVP: boolean;
  mayShare: boolean;
  mayDelete: boolean;
}

/** A JMAP Calendar: the container a {@link CalendarEvent} belongs to. */
export interface Calendar {
  id: Id;
  name: string;
  description: string | null;
  color: string | null;
  timeZone: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSubscribed: boolean;
  myRights: CalendarRights;
}

/** JSContact-style location of an event (RFC 8984 §4.2.5). Qelo reads `name`. */
export interface EventLocation {
  "@type"?: "Location";
  name?: string;
  description?: string;
  coordinates?: string;
}

/**
 * A JSCalendar Participant (RFC 8984 §4.4.6). `sendTo` maps a method (e.g. `imip`)
 * to a URI (`mailto:…`); some servers also surface a bare `email`. Read-only in Qelo
 * — and note: dev Stalwart silently DROPS participants sent on a JMAP create, so this
 * only populates for iCal-imported events.
 */
export interface EventParticipant {
  "@type"?: "Participant";
  name?: string;
  email?: string;
  sendTo?: Record<string, string>;
  kind?: string;
  roles?: Record<string, true>;
  participationStatus?: string;
  expectReply?: boolean;
}

/**
 * One BYDAY entry of a {@link RecurrenceRule} (RFC 8984 §4.3.3): a weekday code
 * (`mo`/`tu`/…) with an optional ordinal (`nthOfPeriod`, e.g. 2 = "2nd Tuesday").
 */
export interface NDay {
  "@type"?: "NDay";
  day: string;
  nthOfPeriod?: number;
}

/**
 * A JSCalendar recurrence rule (RFC 8984 §4.3.3).
 *
 * WIRE NOTE: dev Stalwart v0.16 exposes this as the SINGULAR `recurrenceRule` on an
 * event and REJECTS the RFC-8984 plural `recurrenceRules` array (`invalidProperties`).
 * Qelo types/writes what the server accepts (per CLAUDE.md "types follow the wire"),
 * but a spec-strict server / Fastmail uses the plural array — keep that in mind if
 * recurrence ever becomes writable or this client targets another server.
 */
export interface RecurrenceRule {
  "@type"?: "RecurrenceRule";
  frequency: string;
  interval?: number;
  byDay?: NDay[];
  byMonthDay?: number[];
  count?: number;
  until?: string;
  firstDayOfWeek?: string;
}

/**
 * One entry of an event's `recurrenceOverrides` (RFC 8984 §4.3.5): a JSCalendar PatchObject that
 * overrides properties of the single occurrence keyed by its `recurrenceId` (the occurrence's
 * original computed local date-time), or `{ excluded: true }` to remove that occurrence. Keys are
 * JSON pointers relative to the event (`"title"`, `"start"`, `"locations/l1/name"`, …); a value of
 * `null` removes the pointed-at value. Typed loosely (the patch can name any event property).
 *
 * WIRE NOTE (dev Stalwart v0.16, probed live 2026-06-18): `recurrenceOverrides` is WRITE-ONLY here —
 * `CalendarEvent/get` never returns it (so overrides can't be read back to merge; rely on the
 * server-side whole-map MERGE). A POINTER patch into the map (`recurrenceOverrides/<key>`) is
 * REJECTED — always send the whole `recurrenceOverrides` map value. And an overridden occurrence is
 * DROPPED from an `expandRecurrences` expansion UNLESS its patch includes a `title` — so Qelo always
 * carries the occurrence's title into a property override (see `overridePatch` in lib/calendar).
 */
export type RecurrenceOverride = Record<string, unknown>;

/**
 * JSCalendar `relatedTo` (RFC 8984 §4.1.3): links this object to others by their `uid`, each with a
 * set of relation types (e.g. `{ next: true }` / `{ first: true }`) used to chain a split series.
 * TYPED BUT UNUSED — split-LINKING is DEFERRED on Stalwart because `CalendarEvent/get` never returns
 * `uid`, so a series we didn't create has no readable uid to link to (see the recurrence milestone
 * plan). The "this and following" split ships FUNCTIONALLY without the link.
 */
export interface Relation {
  "@type"?: "Relation";
  relation?: Record<string, true>;
}

/**
 * A JSCalendar Event (RFC 8984) as returned by `CalendarEvent/get`. Only the subset
 * Qelo reads is fully typed; rarer properties (alerts, links, virtualLocations, …) are
 * left out until a feature needs them rather than guessed.
 *
 * `start` is a LOCAL date-time string (no `Z`/offset) interpreted in `timeZone`; an
 * all-day event is `showWithoutTime: true` with a null `timeZone` and a date-valued
 * `duration` (e.g. `P1D`). An expanded recurrence occurrence (from a `CalendarEvent/query`
 * with `expandRecurrences`) carries its own `start` plus a `recurrenceId` marking which
 * occurrence it is — see [[qelo-calendar-milestone-status]].
 */
export interface CalendarEvent {
  "@type": "Event";
  id: Id;
  uid?: string;
  calendarIds?: Record<Id, true>;
  title?: string;
  description?: string;
  start?: string;
  timeZone?: string | null;
  duration?: string;
  showWithoutTime?: boolean;
  status?: string;
  freeBusyStatus?: string;
  privacy?: string;
  color?: string | null;
  keywords?: Record<string, true>;
  locations?: Record<string, EventLocation>;
  participants?: Record<string, EventParticipant>;
  recurrenceRule?: RecurrenceRule;
  recurrenceOverrides?: Record<string, RecurrenceOverride>;
  relatedTo?: Record<string, Relation>;
  recurrenceId?: string;
  recurrenceIdTimeZone?: string;
  isDraft?: boolean;
  isOrigin?: boolean;
  updated?: UtcDate;
}

export type MethodCall = [string, Record<string, unknown>, string];
export type MethodResponse = [string, Record<string, unknown>, string];

export interface JmapRequest {
  using: string[];
  methodCalls: MethodCall[];
  createdIds?: Record<Id, Id>;
}

export interface JmapResponse {
  methodResponses: MethodResponse[];
  createdIds?: Record<Id, Id>;
  sessionState: string;
}
