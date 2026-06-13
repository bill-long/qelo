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
import type { EmailAddress, EmailSubmission, Identity } from "@/jmap/types";
import { parseRecipients } from "@/lib/addresses";
import { handleAuthFailure, jmap } from "./account";
import { mailboxIdByRole } from "./mailboxes";

// Compose v1 (D3): plain-text body only, new message only. The headline JMAP payoff lives in
// send(): one batched Email/set{create #draft} + EmailSubmission/set{create, onSuccessUpdateEmail}
// round trip that creates the message, submits it, and files it Drafts→Sent atomically. We do NOT
// advance any sync cursor from these /sets — the push-driven drain owns that, and will surface the
// new Sent/Drafts/Inbox rows on its own (same discipline as the keyword/mailbox mutations).

// --- Pure builders (unit-tested) -------------------------------------------

export interface DraftEmailInput {
  draftsMailboxId: string;
  from: EmailAddress;
  /** Parsed recipients, or null to omit the field (no recipients of that kind). */
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  subject: string;
  body: string;
  // Threading headers — reserved for PR 4 (reply/forward); always null in v1.
  inReplyTo?: string[] | null;
  references?: string[] | null;
}

/**
 * Build the `Email/set` `create` object for a draft: it lives in the Drafts mailbox and carries
 * `$draft` (+ `$seen`, since the author has obviously seen their own draft). The single text part
 * is `bodyValues.body` referenced by `textBody` (RFC 8621 §4.1.4). Recipient/threading fields are
 * omitted entirely when absent rather than sent as null, keeping the wire object minimal.
 */
export function buildDraftEmail(input: DraftEmailInput): Record<string, unknown> {
  const create: Record<string, unknown> = {
    mailboxIds: { [input.draftsMailboxId]: true },
    keywords: { $draft: true, $seen: true },
    from: [input.from],
    subject: input.subject,
    bodyValues: { body: { value: input.body, isTruncated: false } },
    textBody: [{ partId: "body", type: "text/plain" }],
  };
  if (input.to) create.to = input.to;
  if (input.cc) create.cc = input.cc;
  if (input.bcc) create.bcc = input.bcc;
  if (input.inReplyTo) create.inReplyTo = input.inReplyTo;
  if (input.references) create.references = input.references;
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
  body: string;
  // Reserved for PR 4 (reply threading); always null in v1.
  inReplyTo: string[] | null;
  references: string[] | null;
}

const EMPTY_DRAFT: DraftState = {
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
  inReplyTo: null,
  references: null,
};

export const [draft, setDraft] = createStore<DraftState>({ ...EMPTY_DRAFT });
export const [identities, setIdentities] = createSignal<Identity[]>([]);
export const [selectedIdentityId, setSelectedIdentityId] = createSignal<string | null>(null);
export const [composeOpen, setComposeOpen] = createSignal(false);
/** Which submit is in flight (gates the buttons + drives their labels), or null when idle. */
export const [busy, setBusy] = createSignal<null | "send" | "save">(null);
export const [composeError, setComposeError] = createSignal<string | null>(null);

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
  setComposeOpen(false);
  setDraft({ ...EMPTY_DRAFT });
  setComposeError(null);
}

/** Open the composer on a fresh blank message, loading identities on first use. */
export function openComposer(): void {
  setDraft({ ...EMPTY_DRAFT });
  setComposeError(null);
  setComposeOpen(true);
  if (identities().length === 0) void loadIdentities();
}

/** Discard the in-progress message and close the composer. */
export function discardDraft(): void {
  closeAndReset();
}

/** Reset all compose state — a test seam; app flow goes through open/discard. */
export function resetCompose(): void {
  setDraft({ ...EMPTY_DRAFT });
  setIdentities([]);
  setSelectedIdentityId(null);
  setComposeOpen(false);
  setBusy(null);
  setComposeError(null);
}

/** Fetch the account's sending identities and default the selection to the first. */
export async function loadIdentities(): Promise<void> {
  try {
    const client = jmap();
    const responses = await client.request(
      [identityGet(client.accountId, "i")],
      [CAP_CORE, CAP_MAIL, CAP_SUBMISSION],
    );
    const list = (methodResult(responses, "i").list ?? []) as Identity[];
    setIdentities(list);
    if (!selectedIdentityId() && list[0]) setSelectedIdentityId(list[0].id);
  } catch (err) {
    if (handleAuthFailure(err)) return;
    setComposeError(err instanceof Error ? err.message : String(err));
  }
}

// Build the draft create object from the current reactive state + a resolved identity.
function currentDraftCreate(draftsId: string, identity: Identity): Record<string, unknown> {
  return buildDraftEmail({
    draftsMailboxId: draftsId,
    from: { name: identity.name || null, email: identity.email },
    to: parseRecipients(draft.to),
    cc: parseRecipients(draft.cc),
    bcc: parseRecipients(draft.bcc),
    subject: draft.subject,
    body: draft.body,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
  });
}

/**
 * Save the current message to Drafts (`Email/set create` with `$draft`). Resolves to true on
 * success (and closes the composer — the push drain surfaces the new Drafts row), false on a
 * refusal/failure, which is surfaced via {@link composeError}. Never rejects.
 */
export async function saveDraft(): Promise<boolean> {
  if (busy()) return false;
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
  if (busy()) return false;
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
  // At least one recipient across to/cc/bcc, else there is nothing to submit to.
  if (!parseRecipients(draft.to) && !parseRecipients(draft.cc) && !parseRecipients(draft.bcc)) {
    setComposeError("Add at least one recipient.");
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
