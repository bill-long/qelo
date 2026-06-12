import { describe, expect, it } from "vitest";
import { formatDate, senderName } from "./format";

describe("senderName", () => {
  it("prefers the display name", () => {
    expect(senderName([{ name: "Ada Lovelace", email: "ada@x.test" }])).toBe("Ada Lovelace");
  });

  it("falls back to the email when the name is blank or null", () => {
    expect(senderName([{ name: "  ", email: "a@x.test" }])).toBe("a@x.test");
    expect(senderName([{ name: null, email: "b@x.test" }])).toBe("b@x.test");
  });

  it("handles a missing/empty address list", () => {
    expect(senderName(null)).toBe("(unknown sender)");
    expect(senderName([])).toBe("(unknown sender)");
  });
});

describe("formatDate", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0); // local time, mid-day

  it("shows the time for the same day", () => {
    expect(formatDate(new Date(2026, 5, 15, 9, 5, 0).toISOString(), now)).toBe("09:05");
  });

  it("shows the weekday within the past week", () => {
    const d = new Date(2026, 5, 13, 12, 0, 0);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    expect(formatDate(d.toISOString(), now)).toBe(weekday);
  });

  it("shows month and day earlier in the same year", () => {
    expect(formatDate(new Date(2026, 0, 20, 12, 0, 0).toISOString(), now)).toBe("Jan 20");
  });

  it("shows the year for older dates", () => {
    expect(formatDate(new Date(2024, 10, 2, 12, 0, 0).toISOString(), now)).toBe("Nov 2, 2024");
  });

  it("returns an empty string for invalid input", () => {
    expect(formatDate("not-a-date", now)).toBe("");
  });
});
