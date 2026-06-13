// Open a link from email content in the OS browser.
//
// Email bodies render in a sandboxed, script-less iframe whose CSP and sandbox
// neutralize in-pane navigation, so a link click does nothing on its own. ThreadView
// intercepts clicks from the parent (the iframe is same-origin via allow-same-origin)
// and routes the href here. On desktop we hand the URL to the OS default browser via the
// Tauri opener plugin; in the browser/PWA build we fall back to window.open.
//
// Living in the store layer (alongside push-transport.ts) keeps the Tauri coupling out of
// the protocol (jmap/) and pure-utility (lib/) layers. The scheme allowlist is the
// security boundary: only http(s) reaches an opener, never javascript:/file:/data:/blob:
// — defense in depth on top of the Tauri opener's own scope (opener:default already pins
// open_url to http/https/mailto/tel) and the browser path, which has no such scope.

import { openUrl } from "@tauri-apps/plugin-opener";
import { isDesktop } from "./account";

/**
 * Validate an email-supplied link and return a safe absolute URL to hand to a browser, or
 * `null` to reject it. Only `http:`/`https:` pass — `javascript:`, `data:`, `file:`,
 * `blob:`, `mailto:`, etc. are dropped. Returns the parser-normalized `href` so callers
 * pass a well-formed URL onward rather than the raw attribute text.
 */
export function safeHttpUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // not absolute / unparseable (e.g. a relative href resolved against about:srcdoc)
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

/**
 * Open an email link in the OS browser. Rejects any non-http(s) URL (see {@link safeHttpUrl})
 * before it reaches an opener. Fire-and-forget: the desktop opener returns a promise, so
 * swallow-and-log its rejection rather than leaving an unhandled rejection.
 */
export function openExternal(raw: string): void {
  const url = safeHttpUrl(raw);
  if (!url) return;
  if (isDesktop) {
    void openUrl(url).catch((err) => console.warn("Failed to open link in browser:", err));
  } else {
    // noopener/noreferrer so the opened tab can't reach back via window.opener or leak the
    // (app-local) referrer. Matches the rel we already force on the anchors in sanitize.ts.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
