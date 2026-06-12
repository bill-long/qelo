import DOMPurify from "dompurify";

// Force every link to a new browsing context. Combined with the iframe's sandbox
// (no allow-popups / allow-top-navigation), this means a click can't navigate the
// reading pane to a remote page — which would otherwise replace the message and load
// remote content outside our CSP. (Opening links in the system browser is a later
// feature.) Overriding any author-supplied target also defeats target="_self".
function forceExternalLinkTargets(node: Element): void {
  if (node.nodeName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
}
DOMPurify.addHook("afterSanitizeAttributes", forceExternalLinkTargets);

// DOMPurify hooks are global and cumulative. Under Vite HMR this module can be
// re-evaluated, so drop the hook when the old instance is replaced to avoid stacking
// duplicates. No-op in production, where import.meta.hot is undefined.
import.meta.hot?.dispose(() => DOMPurify.removeHook("afterSanitizeAttributes"));

/**
 * Sanitize untrusted email HTML: strips <script>, event-handler attributes, and
 * javascript: URLs while keeping ordinary formatting and inline styles. Always run
 * this before the result reaches the DOM (even inside the sandboxed iframe).
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// CSP for the reading-pane iframe: no scripts, and the only resources allowed are
// inline styles and data: URIs. This blocks remote images (tracking pixels), web
// fonts, and any other network fetch the message might attempt. base-uri and
// form-action don't fall back to default-src, so lock them down explicitly to neutralize
// any <base> hijack or <form> submission regardless of the iframe sandbox flags.
const EMAIL_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/**
 * Default frame styling for the given theme. `color-scheme` makes the UA render
 * default colors, scrollbars, and the email's own `@media (prefers-color-scheme)`
 * rules for that theme, and the explicit fg/bg make emails that ship no colors of
 * their own readable on either background. (Emails that hard-code light colors are a
 * separate, harder problem — see the deferred "dark-mode color remapping" note.)
 */
function frameStyle(theme: "light" | "dark"): string {
  const fg = theme === "dark" ? "#e8e8e8" : "#1a1a1a";
  const bg = theme === "dark" ? "#1a1a1a" : "#ffffff";
  const link = theme === "dark" ? "#7eb6ff" : "#2563c9";
  return `:root{color-scheme:${theme}}body{margin:0;padding:10px;background:${bg};color:${fg};font:14px/1.55 system-ui,sans-serif;overflow-wrap:break-word}img{max-width:100%;height:auto}a{color:${link}}`;
}

/**
 * Wrap already-sanitized HTML in a minimal document for a sandboxed iframe. The CSP is
 * the privacy boundary (remote content blocked by default); DOMPurify is the script
 * boundary. Remote images stay in the markup but won't load until we add a
 * "load images" affordance later by relaxing the CSP.
 */
export function emailSrcdoc(sanitizedHtml: string, theme: "light" | "dark" = "light"): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}"><style>${frameStyle(theme)}</style></head><body>${sanitizedHtml}</body></html>`;
}
