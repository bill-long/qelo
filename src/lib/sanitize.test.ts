import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@/lib/sanitize";

// Smoke test confirming the test toolchain (Vitest + @/ alias) works.
// Expand with real cases once sanitizeHtml strips scripts/handlers.
describe("sanitizeHtml", () => {
  it("passes plain text through unchanged", () => {
    expect(sanitizeHtml("hello world")).toBe("hello world");
  });
});
