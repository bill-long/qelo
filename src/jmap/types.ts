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
