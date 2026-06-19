import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarNav } from "@/components/calendar/CalendarNav";
import { LOCAL_ZONE } from "@/lib/calendar";
import {
  calendarAnchor,
  calendarDisplayZone,
  setCalendarAnchor,
  setCalendarDisplayZone,
  setCalendarViewMode,
} from "@/stores/ui";

// rangeLabel + todayAnchor read `now`, so pin the clock (Date only — leave real timers so SolidJS is
// undisturbed). Start in month mode anchored at Jun 17 2026.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-17T12:00:00"));
  setCalendarViewMode("month");
  setCalendarAnchor(new Date(2026, 5, 17));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  setCalendarViewMode("agenda");
  setCalendarAnchor(new Date(2026, 5, 17));
  setCalendarDisplayZone(LOCAL_ZONE);
});

describe("CalendarNav", () => {
  it("labels the current window", () => {
    render(() => <CalendarNav />);
    expect(screen.getByText("June 2026")).toBeTruthy();
  });

  it("prev/next step the month and Today resets to now", () => {
    render(() => <CalendarNav />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(calendarAnchor().getMonth()).toBe(6); // July (month step pins to the 1st)
    expect(screen.getByText("July 2026")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(calendarAnchor().getMonth()).toBe(5); // back to June
    expect(screen.getByText("June 2026")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(calendarAnchor()).toEqual(new Date(2026, 5, 17));
  });

  it("offers a labeled display-zone picker including the local zone and curated zones", () => {
    render(() => <CalendarNav />);
    const picker = screen.getByRole("combobox", { name: "Display time zone" });
    expect(picker).toBeTruthy();
    // The resolved local zone is always present, marked "(local)".
    expect(screen.getByRole("option", { name: `${LOCAL_ZONE} (local)` })).toBeTruthy();
    // A curated zone is present too (Asia/Tokyo isn't the CI runner's zone, so it's a plain entry).
    expect(screen.getByRole("option", { name: "Asia/Tokyo" })).toBeTruthy();
  });

  it("picking a zone updates the display-zone signal", () => {
    render(() => <CalendarNav />);
    const picker = screen.getByRole("combobox", { name: "Display time zone" });
    fireEvent.change(picker, { target: { value: "Asia/Tokyo" } });
    expect(calendarDisplayZone()).toBe("Asia/Tokyo");
  });
});
