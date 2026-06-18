import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarMain } from "@/components/calendar/CalendarMain";
import { resetCalendar, setCalendarReady } from "@/stores/calendar";
import { setCalendarViewMode } from "@/stores/ui";

// CalendarMain.onMount fires loadCalendar(), which no-ops without a connected session
// (calendarAccountId() is null → fetchCalendar returns before touching the client), so these tests
// need no client. They cover the mode → body mapping only.
beforeEach(() => {
  resetCalendar();
  setCalendarViewMode("agenda");
});
afterEach(() => {
  cleanup();
  resetCalendar();
  setCalendarViewMode("agenda");
});

describe("CalendarMain", () => {
  it("renders the agenda body in agenda mode", () => {
    setCalendarReady(true); // so the agenda shows its (empty) content, not the loading note
    render(() => <CalendarMain />);
    expect(screen.getByText("No events in this range")).toBeTruthy();
    // The view switch + nav are present.
    expect(screen.getByRole("button", { name: "Month" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Today" })).toBeTruthy();
  });

  it("renders the month grid in month mode", () => {
    setCalendarReady(true); // so the grid shows its cells, not the loading note
    setCalendarViewMode("month");
    render(() => <CalendarMain />);
    // The month grid renders its weekday header; the not-built placeholder must NOT show.
    expect(screen.getByText("Sun")).toBeTruthy();
    expect(screen.queryByText(/arrives later/)).toBeNull();
    expect(screen.queryByText("No events in this range")).toBeNull();
  });

  it("renders the week time-grid in week mode", () => {
    setCalendarReady(true); // so the grid shows its axis + lane, not the loading note
    setCalendarViewMode("week");
    render(() => <CalendarMain />);
    // The time-grid renders its all-day lane label + hour axis; no placeholder, no agenda empty-state.
    expect(screen.getByText("All-day")).toBeTruthy();
    expect(screen.getByText("07:00")).toBeTruthy();
    expect(screen.queryByText(/arrives later/)).toBeNull();
    expect(screen.queryByText("No events in this range")).toBeNull();
  });

  it("renders the day time-grid in day mode", () => {
    setCalendarReady(true);
    setCalendarViewMode("day");
    render(() => <CalendarMain />);
    expect(screen.getByText("All-day")).toBeTruthy();
    expect(screen.getByText("07:00")).toBeTruthy();
    // The agenda's empty-state must NOT leak into day mode either (symmetry with the week test).
    expect(screen.queryByText("No events in this range")).toBeNull();
  });
});
