import { describe, expect, it } from "vitest";
import {
  emailSrcdoc,
  sanitizeComposeFragment,
  sanitizeHtml,
  sanitizeOutboundHtml,
} from "@/lib/sanitize";

describe("sanitizeHtml", () => {
  it("passes plain text through unchanged", () => {
    expect(sanitizeHtml("hello world")).toBe("hello world");
  });

  it("keeps ordinary formatting", () => {
    expect(sanitizeHtml("<p>hi <strong>there</strong></p>")).toBe(
      "<p>hi <strong>there</strong></p>",
    );
  });

  it("strips <script> tags", () => {
    const out = sanitizeHtml("<p>ok</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>ok</p>");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });

  it("strips javascript: URLs", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
  });

  it("forces links to open in a new context (neutralized in-pane by the sandbox)", () => {
    const out = sanitizeHtml('<a href="https://x.test" target="_self">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('target="_self"');
  });
});

describe("sanitizeOutboundHtml", () => {
  it("keeps the formatting the composer + quoting produce", () => {
    const html =
      "<div>hi <b>bold</b> <i>italic</i></div><ul><li>a</li></ul>" +
      '<a href="https://x.test">link</a><blockquote>quoted</blockquote>';
    const out = sanitizeOutboundHtml(html);
    expect(out).toContain("<b>bold</b>");
    expect(out).toContain("<i>italic</i>");
    expect(out).toContain("<ul><li>a</li></ul>");
    expect(out).toContain('href="https://x.test"');
    expect(out).toContain("<blockquote>quoted</blockquote>");
  });

  it("does NOT rewrite links to target=_blank (that inbound-only hook must not apply outbound)", () => {
    const out = sanitizeOutboundHtml('<a href="https://x.test">x</a>');
    expect(out).not.toContain("target");
    expect(out).not.toContain("rel=");
  });

  it("strips <script>, event handlers, and javascript: URLs", () => {
    expect(sanitizeOutboundHtml("<p>ok</p><script>alert(1)</script>")).not.toContain("<script");
    expect(sanitizeOutboundHtml('<a href="javascript:alert(1)">x</a>')).not.toContain(
      "javascript:",
    );
    expect(sanitizeOutboundHtml('<b onclick="alert(1)">x</b>')).not.toContain("onclick");
  });

  it("keeps a cid: <img> (an inline image referencing a part this message carries)", () => {
    const out = sanitizeOutboundHtml('<p>see</p><img src="cid:abc@qelo.invalid" alt="logo">');
    expect(out).toContain("<img");
    expect(out).toContain('src="cid:abc@qelo.invalid"');
  });

  it("strips a remote <img> while keeping a cid: one (the tracking-pixel vector stays shut)", () => {
    const out = sanitizeOutboundHtml(
      '<img src="https://tracker.test/p.gif"><img src="cid:keep@qelo.invalid">',
    );
    expect(out).not.toContain("tracker.test");
    expect(out).not.toContain("https://");
    expect(out).toContain('src="cid:keep@qelo.invalid"');
  });

  it("strips a data: <img> too (cid: is the ONLY allowed image source)", () => {
    const data = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(sanitizeOutboundHtml(data)).not.toContain("<img");
    expect(sanitizeOutboundHtml(data)).not.toContain("data:");
  });

  it("drops an <img> whose src DOMPurify already stripped (e.g. javascript:), not just leaves it bare", () => {
    expect(sanitizeOutboundHtml('<img src="javascript:alert(1)">')).not.toContain("<img");
  });

  it("drops an empty-cid <img> (cid: with no token would be a dead reference)", () => {
    expect(sanitizeOutboundHtml('<img src="cid:">')).not.toContain("<img");
  });

  it("strips a remote src that landed on a NON-img tag (src is allowed globally, cid-gated only on img)", () => {
    const out = sanitizeOutboundHtml(
      '<a href="https://x.test" src="https://tracker.test/p.gif">x</a>',
    );
    expect(out).toContain('href="https://x.test"');
    expect(out).not.toContain("tracker.test");
    expect(out).not.toContain("src=");
  });

  it("drops disallowed structural tags but keeps their text", () => {
    expect(sanitizeOutboundHtml("<style>p{color:red}</style><p>body</p>")).not.toContain("<style");
    expect(sanitizeOutboundHtml("<iframe src='x'></iframe><p>body</p>")).not.toContain("<iframe");
    expect(sanitizeOutboundHtml("<form><input></form><p>body</p>")).toContain("<p>body</p>");
  });
});

describe("sanitizeComposeFragment", () => {
  it("returns a DocumentFragment cleaned to the outbound policy (for Squire's paste boundary)", () => {
    const frag = sanitizeComposeFragment(
      '<p>ok</p><script>alert(1)</script><img src="https://tracker.test/x.gif">',
    );
    expect(frag).toBeInstanceOf(DocumentFragment);
    expect(frag.querySelector("script")).toBeNull();
    // The remote <img> (a quoted tracking pixel) is dropped at the editor boundary, before it can
    // reach the non-sandboxed compose DOM.
    expect(frag.querySelector("img")).toBeNull();
    expect(frag.querySelector("p")?.textContent).toBe("ok");
  });

  it("keeps a cid: <img> at the editor boundary (so a quoted/inserted inline image survives)", () => {
    const frag = sanitizeComposeFragment('<img src="cid:keep@qelo.invalid">');
    expect(frag.querySelector("img")?.getAttribute("src")).toBe("cid:keep@qelo.invalid");
  });
});

describe("emailSrcdoc", () => {
  it("embeds a CSP that blocks remote images and scripts", () => {
    const doc = emailSrcdoc("<p>body</p>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("img-src data:"); // remote images cannot load
    expect(doc).toContain("<p>body</p>");
  });

  it("renders in the requested color scheme", () => {
    expect(emailSrcdoc("<p>x</p>", "dark")).toContain("color-scheme:dark");
    expect(emailSrcdoc("<p>x</p>", "light")).toContain("color-scheme:light");
  });

  it("remaps hard-coded light colors only in dark mode", () => {
    const html = '<p style="color:#000000">hi</p>';
    expect(emailSrcdoc(html, "light")).toContain("color:#000000");
    const dark = emailSrcdoc(html, "dark");
    // The authored black is gone, replaced with a light color (hex or rgb serialization).
    expect(dark).not.toMatch(/color:\s*(#000000|rgb\(0, 0, 0\))/);
    expect(dark).toMatch(/#ffffff|rgb\(255, 255, 255\)/);
  });
});
