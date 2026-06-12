import { describe, expect, it } from "vitest";
import { emailSrcdoc, sanitizeHtml } from "@/lib/sanitize";

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
});
