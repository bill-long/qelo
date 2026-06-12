import type { Email } from "@/jmap/types";

export interface SelectedBody {
  kind: "html" | "text" | "none";
  value: string;
}

/**
 * Pick the body to render: prefer the first HTML part, fall back to the first plain
 * text part, then nothing. Returns the decoded value from `bodyValues` (which must
 * have been fetched, e.g. via fetchHTMLBodyValues), keyed by the part's partId.
 */
export function selectBody(email: Email): SelectedBody {
  const html = email.htmlBody?.[0];
  if (html?.partId) {
    const value = email.bodyValues?.[html.partId]?.value;
    if (value !== undefined) return { kind: "html", value };
  }
  const text = email.textBody?.[0];
  if (text?.partId) {
    const value = email.bodyValues?.[text.partId]?.value;
    if (value !== undefined) return { kind: "text", value };
  }
  return { kind: "none", value: "" };
}
