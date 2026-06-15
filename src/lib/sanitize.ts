import DOMPurify from "dompurify";
import { adaptHtmlForDark } from "@/lib/dark-html";

// Force every link to a new browsing context. Combined with the iframe's sandbox
// (no allow-popups / allow-top-navigation), this means a click can't navigate the
// reading pane to a remote page — which would otherwise replace the message and load
// remote content outside our CSP. ThreadView intercepts clicks and opens http(s) links in
// the OS browser (see stores/open-external.ts); this target/rel is the defense-in-depth
// fallback if that handler ever doesn't run. Overriding any author-supplied target also
// defeats target="_self".
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

// --- Outbound (compose / send) sanitization --------------------------------

// A SEPARATE DOMPurify instance for the OUTBOUND path (the HTML the user composes + the source HTML
// they quote on reply/forward). It deliberately does NOT share the module singleton's hooks: the
// singleton carries `forceExternalLinkTargets`, which rewrites every <a> to target="_blank" — right
// for the reading-pane iframe, but wrong for mail we author and send (it would pollute the
// recipient's copy with a meaningless target). DOMPurify's default export is callable to mint a
// fresh instance bound to the same window; this one carries exactly ONE outbound-only hook,
// `restrictImgToCid` (added below), and none of the inbound singleton's.
const outboundPurify = DOMPurify(window);

// Inline images (Phase 2) are referenced by `cid:` — a part the same message carries — never by a
// remote/data URL. DOMPurify's default IS_ALLOWED_URI permits http(s) <img src> (and, because <img>
// is a default DATA_URI tag, data: too), so allowing <img> at all would let a quoted hostile message
// smuggle a remote tracking pixel into our NON-sandboxed compose DOM (the app CSP is null) — exactly
// the vector the no-<img> Phase-1 stance closed. ALLOWED_URI_REGEXP can't help: it applies to every
// URI attribute, so clamping it to cid: would also break <a href>. So police <img src> directly: drop
// any <img> whose src isn't cid:. afterSanitizeAttributes runs after DOMPurify's own URI check, so a
// javascript:/stripped src arrives here as empty and is likewise dropped.
function restrictImgToCid(node: Element): void {
  if (node.nodeName !== "IMG") {
    // `src` is allowed for <img>, but ALLOWED_ATTR is global — so strip a `src` that landed on any
    // OTHER element (e.g. a hostile quoted `<a href="…" src="https://tracker">`) so it can't carry a
    // remote URL into the wire/compose DOM. No outbound-allowed non-img tag has a meaningful src.
    if (node.hasAttribute("src")) node.removeAttribute("src");
    return;
  }
  const src = node.getAttribute("src") ?? "";
  // Require a non-empty cid after the scheme: a bare `cid:` would pass a prefix-only check but never
  // match cidsReferencedIn (which needs a token), leaving a dead <img> with no backing inline part.
  if (!/^cid:.+/i.test(src.trim())) node.remove();
}
outboundPurify.addHook("afterSanitizeAttributes", restrictImgToCid);
// Unlike the singleton hook above, this instance is freshly minted on each module eval, so its hooks
// vanish with it under HMR — no dispose needed to avoid stacking.

// The tags/attributes the outbound path keeps. This is intentionally an allowlist (not the broad
// inbound `html` profile): the composer's toolbar only ever emits bold/italic/list/link/blockquote
// markup, and quoted source HTML is re-emitted into mail we own, so a tight, predictable set keeps
// the sent message clean and shrinks the surface a quoted hostile message could smuggle through.
// NOTE (Phase 2): <img> is allowed, but `restrictImgToCid` (above) drops any whose src isn't cid:,
// so only our own inline-image references survive — remote/data <img> never reaches the wire or the
// non-sandboxed compose DOM.
const OUTBOUND_ALLOWED_TAGS = [
  "p",
  "div",
  "br",
  "span",
  "blockquote",
  "pre",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "sub",
  "sup",
  "code",
  "a",
  "img",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
];
const OUTBOUND_ALLOWED_ATTR = [
  "href",
  "title",
  "dir",
  "colspan",
  "rowspan",
  // <img> — src is further restricted to cid: by restrictImgToCid; alt/width/height carry inline-image fidelity.
  "src",
  "alt",
  "width",
  "height",
];

/**
 * Sanitize HTML bound for the wire (the composed body + any quoted source HTML), to the tight
 * outbound allowlist and WITHOUT the inbound link-target rewrite. Run on `bodyHtml` immediately
 * before it becomes the `text/html` part in {@link buildDraftEmail}'s create.
 */
export function sanitizeOutboundHtml(html: string): string {
  return outboundPurify.sanitize(html, {
    ALLOWED_TAGS: OUTBOUND_ALLOWED_TAGS,
    ALLOWED_ATTR: OUTBOUND_ALLOWED_ATTR,
  });
}

/**
 * The same outbound policy, returning a DocumentFragment — wired into Squire's `sanitizeToDOMFragment`
 * so everything entering the editor (pasted clipboard HTML AND the quoted source HTML we seed via
 * setHTML) is cleaned at the editor boundary, before it reaches our non-sandboxed compose DOM. The
 * send-path {@link sanitizeOutboundHtml} is the second, authoritative pass.
 */
export function sanitizeComposeFragment(html: string): DocumentFragment {
  return outboundPurify.sanitize(html, {
    ALLOWED_TAGS: OUTBOUND_ALLOWED_TAGS,
    ALLOWED_ATTR: OUTBOUND_ALLOWED_ATTR,
    RETURN_DOM_FRAGMENT: true,
  });
}

// CSP for the reading-pane iframe: no scripts, and the only resources allowed are
// inline styles and data: URIs. This blocks remote images (tracking pixels), web
// fonts, and any other network fetch the message might attempt. base-uri and
// form-action don't fall back to default-src, so lock them down explicitly to neutralize
// any <base> hijack or <form> submission regardless of the iframe sandbox flags.
const EMAIL_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/**
 * Default frame styling for the given theme. `color-scheme` makes the UA render its
 * default colors, scrollbars, and form controls for that theme, and the explicit fg/bg
 * make emails that ship no colors of their own readable on either background. (DOMPurify
 * strips author `<style>` blocks, so an email's own `@media (prefers-color-scheme)` rules
 * never reach here — emails that hard-code light colors are instead remapped at
 * srcdoc-build time by adaptHtmlForDark; see lib/dark-html.ts.)
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
 * "load images" affordance later by relaxing the CSP. In dark mode, authored light colors
 * are remapped first so hard-coded-light emails match the dark canvas (lib/dark-html.ts).
 */
export function emailSrcdoc(sanitizedHtml: string, theme: "light" | "dark" = "light"): string {
  const body = theme === "dark" ? adaptHtmlForDark(sanitizedHtml) : sanitizedHtml;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EMAIL_CSP}"><style>${frameStyle(theme)}</style></head><body>${body}</body></html>`;
}
