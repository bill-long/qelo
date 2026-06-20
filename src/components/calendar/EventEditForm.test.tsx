import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { EventEditForm } from "@/components/calendar/EventEditForm";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import { dragCreateSeed } from "@/lib/calendar";
import { resetCalendar } from "@/stores/calendar";

function event(partial: Partial<CalendarEvent>): CalendarEvent {
  return { "@type": "Event", id: "u", ...partial };
}

function calendar(partial: Partial<Calendar>): Calendar {
  return {
    id: "b",
    name: "Personal",
    description: null,
    color: null,
    timeZone: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: false,
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: true,
      mayWriteOwn: true,
      mayUpdatePrivate: true,
      mayRSVP: true,
      mayShare: true,
      mayDelete: true,
    },
    ...partial,
  };
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
    render(() => (
      <EventEditForm
        mode="edit"
        event={timed}
        occurrenceId="eaaaaau"
        recurrenceId={null}
        onClose={() => {}}
      />
    ));
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

  it("pre-fills the create form with a drag-to-create swept range (zone-anchored, no title)", () => {
    // The swept range a WeekGrid drag-to-create produces (09:00–11:00 on Jul 6, anchored to the display
    // zone it was swept in).
    const seed = dragCreateSeed("2026-07-06", 9 * 60, 11 * 60, "America/New_York");
    render(() => (
      <EventEditForm mode="create" calendars={[calendar({})]} seed={seed} onClose={() => {}} />
    ));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("2026-07-06T09:00");
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe("2026-07-06T11:00");
    expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe(
      "America/New_York",
    );
    // It's a create form (Create button) and Create is disabled until a title is entered.
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Lunch" } });
    expect(create.disabled).toBe(false);
  });

  it("hides the time-zone picker and uses date inputs when all-day is toggled on", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={timed}
        occurrenceId="eaaaaau"
        recurrenceId={null}
        onClose={() => {}}
      />
    ));
    expect(screen.getByLabelText("Time zone")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("All day"));
    expect(screen.queryByLabelText("Time zone")).toBeNull();
    const start = screen.getByLabelText("Start") as HTMLInputElement;
    expect(start.type).toBe("date");
    // Toggling reformats the value to the date shape so the input isn't left blank.
    expect(start.value).toBe("2026-07-06");
  });

  it("restores the original times when all-day is toggled off again", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={timed}
        occurrenceId="eaaaaau"
        recurrenceId={null}
        onClose={() => {}}
      />
    ));
    fireEvent.click(screen.getByLabelText("All day")); // on → date-only
    fireEvent.click(screen.getByLabelText("All day")); // off → restore the remembered time-of-day
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("2026-07-06T09:00");
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe("2026-07-06T09:30");
  });

  it("blocks save with an inline error when the end is before the start", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={timed}
        occurrenceId="eaaaaau"
        recurrenceId={null}
        onClose={() => {}}
      />
    ));
    fireEvent.input(screen.getByLabelText("End"), { target: { value: "2026-07-06T08:00" } });
    expect(screen.getByRole("alert").textContent).toMatch(/end can't be before/i);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("End") as HTMLInputElement).getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});

describe("EventEditForm recurrence editor", () => {
  const weekly = event({
    title: "Standup",
    start: "2026-07-06T09:00:00",
    timeZone: "America/New_York",
    duration: "PT30M",
    recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly", interval: 2 },
  });

  it("seeds the repeat select + interval from the base rule and shows the weekday picker", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={weekly}
        occurrenceId="eaaaaau"
        recurrenceId="2026-07-06T09:00:00"
        onClose={() => {}}
      />
    ));
    expect((screen.getByLabelText("Repeat") as HTMLSelectElement).value).toBe("weekly");
    expect((screen.getByLabelText("Repeat every") as HTMLInputElement).value).toBe("2");
    // Weekly reveals the weekday checkboxes.
    expect(screen.getByLabelText("Mon")).toBeTruthy();
  });

  it("hides the sub-fields for a non-repeating event and reveals them on choosing a frequency", () => {
    render(() => <EventEditForm mode="create" calendars={[calendar({})]} onClose={() => {}} />);
    expect((screen.getByLabelText("Repeat") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByLabelText("Repeat every")).toBeNull();
    fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: "monthly" } });
    expect(screen.getByLabelText("Repeat every")).toBeTruthy();
    // Monthly reveals the day-of-month / Nth-weekday choice (not the weekday checkboxes).
    expect(screen.getByLabelText("On this day of the month")).toBeTruthy();
    expect(screen.queryByLabelText("Mon")).toBeNull();
  });

  it("reveals the occurrences field and blocks save on a non-positive count", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={weekly}
        occurrenceId="eaaaaau"
        recurrenceId="2026-07-06T09:00:00"
        onClose={() => {}}
      />
    ));
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "count" } });
    const occ = screen.getByLabelText("Occurrences") as HTMLInputElement;
    expect(occ).toBeTruthy();
    fireEvent.input(occ, { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toMatch(/valid repeat/i);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces the when error AND the recurrence error at once (neither masks the other)", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={weekly}
        occurrenceId="eaaaaau"
        recurrenceId="2026-07-06T09:00:00"
        onClose={() => {}}
      />
    ));
    fireEvent.input(screen.getByLabelText("End"), { target: { value: "2026-07-06T08:00" } }); // when
    fireEvent.input(screen.getByLabelText("Repeat every"), { target: { value: "0" } }); // recurrence
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent ?? "");
    expect(alerts.some((t) => /end can't be before/i.test(t))).toBe(true);
    expect(alerts.some((t) => /valid repeat/i.test(t))).toBe(true);
    expect((screen.getByLabelText("End") as HTMLInputElement).getAttribute("aria-invalid")).toBe(
      "true",
    );
  });

  it("keeps at least one weekday checked (can't uncheck the last one)", () => {
    // `weekly` starts 2026-07-06 (Monday) with no byDay → Mon is the lone seeded day.
    render(() => (
      <EventEditForm
        mode="edit"
        event={weekly}
        occurrenceId="eaaaaau"
        recurrenceId="2026-07-06T09:00:00"
        onClose={() => {}}
      />
    ));
    const mon = screen.getByLabelText("Mon") as HTMLInputElement;
    expect(mon.checked).toBe(true);
    fireEvent.click(mon); // try to uncheck the only selected day
    expect((screen.getByLabelText("Mon") as HTMLInputElement).checked).toBe(true); // stays checked
  });

  it("seeds the start's weekday when switching a fresh event to weekly", () => {
    // A create seeded at a known date; switching to Weekly should check that day, not show none.
    render(() => <EventEditForm mode="create" calendars={[calendar({})]} onClose={() => {}} />);
    fireEvent.input(screen.getByLabelText("Start"), { target: { value: "2026-07-08T09:00" } }); // Wed
    fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: "weekly" } });
    expect((screen.getByLabelText("Wed") as HTMLInputElement).checked).toBe(true);
  });
});

describe("EventEditForm recurring apply-mode chooser", () => {
  const weekly = event({
    title: "Standup",
    start: "2026-07-06T09:00:00",
    timeZone: "America/New_York",
    duration: "PT30M",
    recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly" },
  });

  it("opens the apply-mode chooser on Save for a recurring event (instead of submitting)", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={weekly}
        occurrenceId="eaaaaau"
        recurrenceId="2026-07-20T09:00:00"
        onClose={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "This event" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "This and following events" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "All events" })).toBeTruthy();
    // Back returns to the form (the Save button reappears, the chooser is gone).
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "This event" })).toBeNull();
  });

  it("disables 'This event' once the recurrence rule changed (a rule change is whole-series)", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={weekly}
        occurrenceId="eaaaaau"
        recurrenceId="2026-07-20T09:00:00"
        onClose={() => {}}
      />
    ));
    // Unchanged rule → "This event" is enabled.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByRole("button", { name: "This event" }).getAttribute("aria-disabled"),
    ).toBeNull();
    // Change the interval (a rule change) — the fields stay visible while choosing, so it re-gates.
    fireEvent.input(screen.getByLabelText("Repeat every"), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "This event" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(screen.getByText(/applies to the whole series/i)).toBeTruthy();
  });

  it("does NOT show the chooser for a non-recurring event (saves directly)", () => {
    render(() => (
      <EventEditForm
        mode="edit"
        event={timed}
        occurrenceId="eaaaaau"
        recurrenceId={null}
        onClose={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("button", { name: "This event" })).toBeNull();
  });
});

describe("EventEditForm create mode", () => {
  it("shows the create header + a default valid slot, gating Create on a title", () => {
    render(() => <EventEditForm mode="create" calendars={[calendar({})]} onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: "New event" })).toBeTruthy();
    // The seeded default is a valid timed slot (start + 1h end), so the only thing missing is a title.
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const start = screen.getByLabelText("Start") as HTMLInputElement;
    expect(start.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/);

    fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Lunch" } });
    expect(create.disabled).toBe(false);
  });

  it("omits the calendar picker for a single calendar but shows it for several", () => {
    const { unmount } = render(() => (
      <EventEditForm mode="create" calendars={[calendar({})]} onClose={() => {}} />
    ));
    expect(screen.queryByLabelText("Calendar")).toBeNull();
    unmount();

    render(() => (
      <EventEditForm
        mode="create"
        calendars={[calendar({}), calendar({ id: "w", name: "Work", isDefault: false })]}
        onClose={() => {}}
      />
    ));
    const picker = screen.getByLabelText("Calendar") as HTMLSelectElement;
    expect(picker).toBeTruthy();
    // Defaults to the server-default calendar.
    expect(picker.value).toBe("b");
  });

  it("blocks Create when the title is set but the when is invalid", () => {
    render(() => <EventEditForm mode="create" calendars={[calendar({})]} onClose={() => {}} />);
    fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Lunch" } });
    fireEvent.input(screen.getByLabelText("End"), { target: { value: "2000-01-01T00:00" } });
    expect(screen.getByRole("alert").textContent).toMatch(/end can't be before/i);
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("keeps Create disabled with no destination calendar, even with a valid title + when", () => {
    // An empty calendars list (no writable calendar resolved) leaves calendarId() null, so Create
    // stays disabled rather than enabling into a submit that would always fail "No writable calendar".
    render(() => <EventEditForm mode="create" calendars={[]} onClose={() => {}} />);
    fireEvent.input(screen.getByLabelText("Title"), { target: { value: "Lunch" } });
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
