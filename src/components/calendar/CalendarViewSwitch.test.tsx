import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalendarViewSwitch } from "@/components/calendar/CalendarViewSwitch";
import { calendarViewMode, setCalendarViewMode } from "@/stores/ui";

beforeEach(() => setCalendarViewMode("agenda"));
afterEach(() => {
  cleanup();
  setCalendarViewMode("agenda");
});

describe("CalendarViewSwitch", () => {
  it("marks the active mode with aria-pressed and switches on click", () => {
    render(() => <CalendarViewSwitch />);
    const agenda = screen.getByRole("button", { name: "Agenda" });
    const month = screen.getByRole("button", { name: "Month" });
    expect(agenda.getAttribute("aria-pressed")).toBe("true");
    expect(month.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(month);
    expect(calendarViewMode()).toBe("month");
    expect(month.getAttribute("aria-pressed")).toBe("true");
    expect(agenda.getAttribute("aria-pressed")).toBe("false");
  });
});
