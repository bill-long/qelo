import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarNav } from "@/components/calendar/CalendarNav";
import { calendarAnchor, setCalendarAnchor, setCalendarViewMode } from "@/stores/ui";

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
});
