import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarMain } from "@/components/calendar/CalendarMain";
import { LOCAL_ZONE } from "@/lib/calendar";
import { refetchWindow, resetCalendar, setCalendarReady } from "@/stores/calendar";
import { setCalendarDisplayZone, setCalendarViewMode } from "@/stores/ui";

// Spy on refetchWindow (the store's window re-query) so the nav-wiring test can assert the effect
// fires — without a connected session, so the rest of the store stays real. The real refetchWindow is
// a no-op here anyway (not loaded / no account); the mock makes the call observable.
vi.mock("@/stores/calendar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/calendar")>();
  return { ...actual, refetchWindow: vi.fn(() => Promise.resolve()) };
});

// CalendarMain.onMount fires loadCalendar(), which no-ops without a connected session
// (calendarAccountId() is null → fetchCalendar returns before touching the client), so these tests
// need no client. They cover the mode → body mapping + the display-zone → refetch wiring.
beforeEach(() => {
  resetCalendar();
  setCalendarViewMode("agenda");
  setCalendarDisplayZone(LOCAL_ZONE);
  vi.mocked(refetchWindow).mockClear();
});
afterEach(() => {
  cleanup();
  resetCalendar();
  setCalendarViewMode("agenda");
  setCalendarDisplayZone(LOCAL_ZONE);
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

  it("re-queries the window when the display zone changes (picker → refetch wiring)", () => {
    setCalendarReady(true);
    render(() => <CalendarMain />);
    // The effect is deferred, so the initial mount doesn't refetch (the lazy load owns the first fetch).
    expect(vi.mocked(refetchWindow)).not.toHaveBeenCalled();
    // Picking another zone re-derives the window — the same posture as a nav step.
    fireEvent.change(screen.getByRole("combobox", { name: "Display time zone" }), {
      target: { value: "Asia/Tokyo" },
    });
    expect(vi.mocked(refetchWindow)).toHaveBeenCalledTimes(1);
  });
});
