import { describe, expect, it } from "vitest";
import { safeHttpUrl } from "@/stores/open-external";

describe("safeHttpUrl", () => {
  it("accepts http and https URLs, returning the normalized href", () => {
    expect(safeHttpUrl("https://example.test/path?q=1")).toBe("https://example.test/path?q=1");
    expect(safeHttpUrl("http://example.test")).toBe("http://example.test/");
  });

  it("rejects dangerous schemes", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpUrl("blob:https://example.test/abc")).toBeNull();
  });

  it("rejects non-http(s) but otherwise ordinary schemes (out of scope here)", () => {
    expect(safeHttpUrl("mailto:someone@example.test")).toBeNull();
    expect(safeHttpUrl("tel:+15551234")).toBeNull();
  });

  it("rejects relative or unparseable hrefs", () => {
    // Relative hrefs in a srcdoc frame resolve against about:srcdoc, not http(s).
    expect(safeHttpUrl("/relative/path")).toBeNull();
    expect(safeHttpUrl("about:srcdoc")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });
});
