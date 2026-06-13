// Pure helpers for turning a compose recipient field (a raw, comma/semicolon-separated
// string the user typed) into the `EmailAddress[]` JMAP wants, and for validating it. No
// SolidJS, no JMAP — just string → address parsing, so it's unit-tested in isolation.

import type { EmailAddress } from "@/jmap/types";

// Deliberately conservative: one local part, an `@`, a dotted domain with a 2+ char TLD, no
// spaces. Compose validation should reject obvious typos, not adjudicate the full RFC 5322
// grammar (the server does the authoritative check) — so we keep it strict-but-simple rather
// than risk a permissive regex that waves through `foo@bar`.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** True if `value` is a plausible single email address (trimmed). */
export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/**
 * Split a recipient field on commas/semicolons/whitespace into trimmed, non-empty tokens.
 * Used by both the parser and the validator so they agree on what "the entries" are.
 */
export function splitRecipients(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a recipient field into `EmailAddress[]` (name always null — plain-text compose v1
 * takes bare addresses, not `Name <addr>` forms). Invalid tokens are dropped here; call
 * {@link invalidRecipients} first to surface them to the user. Returns `null` rather than an
 * empty array when there are no valid recipients, so a caller can omit the field entirely.
 */
export function parseRecipients(raw: string): EmailAddress[] | null {
  const valid = splitRecipients(raw).filter(isValidEmail);
  if (valid.length === 0) return null;
  return valid.map((email) => ({ name: null, email }));
}

/** The tokens in a recipient field that are NOT valid addresses (for inline validation). */
export function invalidRecipients(raw: string): string[] {
  return splitRecipients(raw).filter((token) => !isValidEmail(token));
}
