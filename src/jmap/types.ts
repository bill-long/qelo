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
