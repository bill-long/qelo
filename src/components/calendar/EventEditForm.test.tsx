import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { EventEditForm } from "@/components/calendar/EventEditForm";
import type { CalendarEvent } from "@/jmap/types";
import { resetCalendar } from "@/stores/calendar";

function event(partial: Partial<CalendarEvent>): CalendarEvent {
  return { "@type": "Event", id: "u", ...partial };
}

const timed = event({
  title: "Standup",
  description: "Daily sync",
  start: "2026-07-06T09:00:00",
  timeZone: "America/New_York",
  duration: "PT30M",
  status: "confirmed",
  locations: { l1: { "@type": "Location", name: "Room A" } },
});

afterEach(() => {
  cleanup();
  resetCalendar();
});

describe("EventEditForm", () => {
  it("seeds the inputs from the base event", () => {
    render(() => <EventEditForm event={timed} occurrenceId="eaaaaau" onClose={() => {}} />);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Standup");
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("2026-07-06T09:00");
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe("2026-07-06T09:30");
    expect((screen.getByLabelText("Location") as HTMLInputElement).value).toBe("Room A");
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe(
      "America/New_York",
    );
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("confirmed");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("hides the time-zone picker and uses date inputs when all-day is toggled on", () => {
    render(() => <EventEditForm event={timed} occurrenceId="eaaaaau" onClose={() => {}} />);
    expect(screen.getByLabelText("Time zone")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("All day"));
    expect(screen.queryByLabelText("Time zone")).toBeNull();
    const start = screen.getByLabelText("Start") as HTMLInputElement;
    expect(start.type).toBe("date");
    // Toggling reformats the value to the date shape so the input isn't left blank.
    expect(start.value).toBe("2026-07-06");
  });

  it("blocks save with an inline error when the end is before the start", () => {
    render(() => <EventEditForm event={timed} occurrenceId="eaaaaau" onClose={() => {}} />);
    fireEvent.input(screen.getByLabelText("End"), { target: { value: "2026-07-06T08:00" } });
    expect(screen.getByRole("alert").textContent).toMatch(/end can't be before/i);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("End") as HTMLInputElement).getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});
