import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import {
  createEventError,
  createSeedDate,
  defaultWritableCalendarId,
  type EditableEvent,
  type EditableRecurrence,
  editableEventError,
  editableHasContent,
  emptyEditableEvent,
  eventToEditable,
  recurrenceValid,
} from "@/lib/calendar";
import { createEvent, saveEvent } from "@/stores/calendar";
import { notify } from "@/stores/toasts";
import { calendarAnchor, calendarViewMode } from "@/stores/ui";

// The JSCalendar enum vocabularies the form exposes as <select>s. "" = unset (the server default);
// kept distinct so opening and saving an event whose property the server never set stays a no-op.
const STATUS_OPTIONS = ["confirmed", "tentative", "cancelled"];
const FREE_BUSY_OPTIONS = ["free", "busy"];
const PRIVACY_OPTIONS = ["public", "private", "secret"];

// Display copy for an invalid recurrence (mirrors lib/calendar's gate message). Shown in the recurrence
// block, not under the date fields.
const RECURRENCE_ERROR =
  "Enter a valid repeat: an interval of 1 or more, a positive count, or a valid end date.";

// The repeat <select> options + the per-frequency interval unit ("week" → "weeks").
const FREQUENCY_OPTIONS: { value: EditableRecurrence["frequency"]; label: string }[] = [
  { value: "", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];
const INTERVAL_UNIT: Record<string, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};
// Weekday picker (Mon-first display) → byDay codes.
const WEEKDAY_PICKER: { code: string; label: string }[] = [
  { code: "mo", label: "Mon" },
  { code: "tu", label: "Tue" },
  { code: "we", label: "Wed" },
  { code: "th", label: "Thu" },
  { code: "fr", label: "Fri" },
  { code: "sa", label: "Sat" },
  { code: "su", label: "Sun" },
];

// The IANA time-zone ids for the tz picker. Intl.supportedValuesOf is in modern engines (and Node
// 18+, so it's present under the test runner); fall back to just the event's own zone if absent so
// the picker still shows a valid current value.
function timeZoneOptions(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const all = current && !supported.includes(current) ? [current, ...supported] : supported;
  return all;
}

/** Edit an existing event, or create a fresh one in a chosen writable calendar. The `calendars`
 * (create mode) are the writable calendars the new event can land in — normally non-empty (the
 * `NewEventButton` affordance only renders when one exists), but the form doesn't rely on that: an
 * empty list leaves `calendarId()` null, which disables Create and is guarded again at submit. */
export type EventEditFormProps = { onClose: () => void } & (
  | { mode: "edit"; event: CalendarEvent; occurrenceId: string }
  | { mode: "create"; calendars: Calendar[] }
);

/**
 * Edit an existing event, or create a new one, in place (column 3, replacing the read-only
 * EventDetail). A working copy — seeded from the resolved BASE event (`eventToEditable`) when editing,
 * a default one-hour slot (`emptyEditableEvent`) when creating — is edited locally; Save dispatches
 * `saveEvent` (a minimal patch against the open-time baseline) or `createEvent` (a new event in the
 * chosen calendar), which own the JMAP round trip + the agenda reconcile. Covers title, when
 * (start/end/all-day/timeZone), location, description, the status/free-busy/privacy enums, AND the
 * recurrence rule (frequency/interval/weekdays/end — the `RecurrenceEditor` below); participants stay
 * present-but-uneditable and carry through untouched. For a RECURRING event this edits the whole series
 * (it patches the base event); the per-occurrence apply modes (this / this-and-following) land in a
 * later branch. Errors surface inline (toasts are success-only); a successful save/create confirms with
 * a toast and closes back to the detail.
 */
export function EventEditForm(props: EventEditFormProps) {
  // Freeze a plain-object snapshot of the base event at open (edit mode only). It seeds the working
  // copy AND is the baseline saveEvent diffs against, so the patch is exactly the user's delta (and a
  // concurrent background sync can't shift the baseline out from under the edit). A one-time read:
  // re-deriving mid-edit would clobber typing, and a selection change unmounts the form (EventView
  // exits edit/create mode).
  // eslint-disable-next-line solid/reactivity
  const editEvent = props.mode === "edit" ? props.event : null;
  const baseline = editEvent ? (structuredClone(unwrap(editEvent)) as CalendarEvent) : null;
  // eslint-disable-next-line solid/reactivity
  const occurrenceId = props.mode === "edit" ? props.occurrenceId : "";
  // Edit seeds from the base event; create seeds a default slot in the VISIBLE window (createSeedDate
  // reads the current mode + anchor) so a new event made while the calendar is navigated away from
  // today lands on screen, not off-window on today. Keyed off `baseline` (null only in create mode) so
  // there's no extra props read; a one-time capture at open (the form unmounts on a selection change).
  const initial = baseline
    ? eventToEditable(baseline)
    : emptyEditableEvent(createSeedDate(calendarViewMode(), calendarAnchor()));
  const [form, setForm] = createStore<EditableEvent>(initial);
  // Create mode: which writable calendar the new event lands in. Defaults to the server-default
  // writable calendar; a `<select>` lets the user pick only when there's more than one. (Static for
  // the form's life — the list doesn't change under an open form; reading props.calendars once is fine.)
  // eslint-disable-next-line solid/reactivity
  const createCalendars = props.mode === "create" ? props.calendars : [];
  const [calendarId, setCalendarId] = createSignal<string | null>(
    defaultWritableCalendarId(createCalendars),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The when-validation message (end-before-start, unparseable) — reactive over the form, shown by
  // the end field. In edit mode it only flags a CHANGED when (an untouched event stays submittable,
  // its empty patch a no-op); in create mode any invalid when is flagged (a create needs a concrete
  // when). Save gating: edit blocks on a when error; create blocks on `editableHasContent` (title +
  // valid when) AND a resolved destination calendar — so the button can't enable into a submit that
  // would always fail with "No writable calendar" (e.g. an empty `calendars`, should rights change).
  // The combined validity (when + recurrence) — the store-boundary truth that gates Save.
  const formError = createMemo(() =>
    baseline ? editableEventError(baseline, form) : createEventError(form),
  );
  // Recurrence error renders in the recurrence block; the when message renders under End. Split so an
  // invalid repeat doesn't mark the date fields aria-invalid (formError checks the when first, so when
  // the recurrence is valid a non-null formError is attributable to the when).
  const recurrenceError = createMemo(() =>
    recurrenceValid(form.recurrence) ? null : RECURRENCE_ERROR,
  );
  const whenError = createMemo(() => (recurrenceError() ? null : formError()));
  const canSubmit = createMemo(() =>
    baseline
      ? formError() === null
      : editableHasContent(form) && calendarId() !== null && formError() === null,
  );
  const timeZones = createMemo(() => timeZoneOptions(form.timeZone));
  let titleInput: HTMLInputElement | undefined;
  onMount(() => titleInput?.focus());

  // Toggling all-day switches the start/end inputs between `date` and `datetime-local`, whose value
  // formats differ ("YYYY-MM-DD" vs "YYYY-MM-DDTHH:mm"). A mismatched value renders an EMPTY input, so
  // reformat to the new shape. Going to all-day we drop the time BUT remember it, so toggling back
  // restores the original time-of-day (combined with the current date, so a date edited while all-day
  // is kept) instead of silently forcing a default — only a never-had-a-time field falls back to one.
  // Seeded from the plain `initial` editable (not the reactive store) — a one-time capture of the
  // event's original timed values to restore on an all-day round-trip.
  let rememberedStart = initial.allDay ? "" : initial.start;
  let rememberedEnd = initial.allDay ? "" : initial.end;
  function timeOf(value: string, fallback: string): string {
    return value.length >= 16 ? value.slice(11, 16) : fallback;
  }
  function setAllDay(checked: boolean) {
    setForm(
      produce((f) => {
        if (checked && !f.allDay) {
          rememberedStart = f.start;
          rememberedEnd = f.end;
          f.start = f.start.slice(0, 10);
          f.end = f.end.slice(0, 10);
        } else if (!checked && f.allDay) {
          // Re-attach the remembered time-of-day to the (possibly edited) date; default only when the
          // event never had a time (opened all-day, no remembered value).
          if (f.start.length === 10) f.start = `${f.start}T${timeOf(rememberedStart, "09:00")}`;
          if (f.end.length === 10) f.end = `${f.end}T${timeOf(rememberedEnd, "10:00")}`;
        }
        f.allDay = checked;
      }),
    );
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    if (busy() || !canSubmit()) return;
    setBusy(true);
    setError(null);
    // unwrap the store proxy to a plain EditableEvent for the pure transforms in the store action.
    const edits = unwrap(form);
    if (baseline) {
      const result = await saveEvent(occurrenceId, baseline.id, baseline, edits);
      setBusy(false);
      if (result.ok) {
        notify("Event saved");
        props.onClose();
        return;
      }
      // The auth case raises the global re-auth gate — keep the form as-is and say nothing here.
      if (result.reason === "auth") return;
      setError(
        result.reason === "refused"
          ? "The server refused the change. The calendar may be read-only, or the event may have changed elsewhere."
          : result.reason === "invalid"
            ? "Enter a valid start and end."
            : "Couldn't save the event. Please try again.",
      );
      return;
    }

    const cal = calendarId();
    if (!cal) {
      setBusy(false);
      setError("No writable calendar to create the event in.");
      return;
    }
    const result = await createEvent(edits, { [cal]: true });
    setBusy(false);
    if (result.ok) {
      notify("Event created");
      props.onClose(); // createEvent already selected the new event (when it's in the agenda window)
      return;
    }
    if (result.reason === "auth") return;
    setError(
      result.reason === "refused"
        ? "The server refused the new event. The calendar may be read-only."
        : "Couldn't create the event. Please try again.",
    );
  }

  return (
    <form
      class="event-edit"
      aria-labelledby="event-edit-title"
      onSubmit={(e) => void handleSubmit(e)}
    >
      <header class="event-edit-head">
        <h1 id="event-edit-title" class="event-detail-title">
          {props.mode === "create" ? "New event" : "Edit event"}
        </h1>
      </header>

      {/* Calendar picker — create mode with a choice (>1). One writable calendar needs no picker
          (it's implicit); an empty list shows no picker either and disables Create (the gate above). */}
      <Show when={props.mode === "create" && createCalendars.length > 1}>
        <label class="event-edit-field">
          <span class="event-edit-label">Calendar</span>
          <select
            class="event-edit-input"
            value={calendarId() ?? ""}
            onChange={(e) => setCalendarId(e.currentTarget.value)}
          >
            <For each={createCalendars}>{(cal) => <option value={cal.id}>{cal.name}</option>}</For>
          </select>
        </label>
      </Show>

      <label class="event-edit-field">
        <span class="event-edit-label">Title</span>
        <input
          ref={titleInput}
          type="text"
          class="event-edit-input"
          value={form.title}
          onInput={(e) => setForm("title", e.currentTarget.value)}
        />
      </label>

      <label class="event-edit-check">
        <input
          type="checkbox"
          checked={form.allDay}
          onChange={(e) => setAllDay(e.currentTarget.checked)}
        />
        <span>All day</span>
      </label>

      <div class="event-edit-when">
        <label class="event-edit-field">
          <span class="event-edit-label">Start</span>
          <input
            type={form.allDay ? "date" : "datetime-local"}
            class="event-edit-input"
            value={form.start}
            aria-invalid={whenError() ? "true" : undefined}
            onInput={(e) => setForm("start", e.currentTarget.value)}
          />
        </label>
        <label class="event-edit-field">
          <span class="event-edit-label">End</span>
          <input
            type={form.allDay ? "date" : "datetime-local"}
            class="event-edit-input"
            value={form.end}
            aria-invalid={whenError() ? "true" : undefined}
            aria-describedby={whenError() ? "event-edit-when-error" : undefined}
            onInput={(e) => setForm("end", e.currentTarget.value)}
          />
        </label>
      </div>
      <Show when={whenError()}>
        {(message) => (
          <p id="event-edit-when-error" class="event-edit-error" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <Show when={!form.allDay}>
        <label class="event-edit-field">
          <span class="event-edit-label">Time zone</span>
          <select
            class="event-edit-input"
            value={form.timeZone}
            onChange={(e) => setForm("timeZone", e.currentTarget.value)}
          >
            <option value="">Floating (no time zone)</option>
            <For each={timeZones()}>{(tz) => <option value={tz}>{tz}</option>}</For>
          </select>
        </label>
      </Show>

      <RecurrenceEditor
        recurrence={form.recurrence}
        error={recurrenceError()}
        onChange={(patch) => setForm("recurrence", patch)}
      />

      <label class="event-edit-field">
        <span class="event-edit-label">Location</span>
        <input
          type="text"
          class="event-edit-input"
          value={form.location}
          onInput={(e) => setForm("location", e.currentTarget.value)}
        />
      </label>

      <label class="event-edit-field">
        <span class="event-edit-label">Description</span>
        <textarea
          class="event-edit-input"
          rows="4"
          value={form.description}
          onInput={(e) => setForm("description", e.currentTarget.value)}
        />
      </label>

      <div class="event-edit-enums">
        <EnumField
          label="Status"
          value={form.status}
          options={STATUS_OPTIONS}
          onChange={(v) => setForm("status", v)}
        />
        <EnumField
          label="Free/busy"
          value={form.freeBusyStatus}
          options={FREE_BUSY_OPTIONS}
          onChange={(v) => setForm("freeBusyStatus", v)}
        />
        <EnumField
          label="Privacy"
          value={form.privacy}
          options={PRIVACY_OPTIONS}
          onChange={(v) => setForm("privacy", v)}
        />
      </div>

      <Show when={error()}>
        {(message) => (
          <p class="event-edit-error" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <footer class="event-edit-actions">
        <button type="submit" class="event-edit-save" disabled={busy() || !canSubmit()}>
          {busy()
            ? props.mode === "create"
              ? "Creating…"
              : "Saving…"
            : props.mode === "create"
              ? "Create"
              : "Save"}
        </button>
        <button
          type="button"
          class="event-edit-cancel"
          disabled={busy()}
          onClick={() => props.onClose()}
        >
          Cancel
        </button>
      </footer>
    </form>
  );
}

// The recurrence-rule editor: a repeat frequency + (when repeating) interval, weekly weekday picker,
// monthly day-of-month vs Nth-weekday choice, and an end (never / after N / on date). Edits the form's
// `recurrence` working copy via `onChange` (a partial merge). Reads props reactively (no destructuring,
// per SolidJS) so the conditional sections track the chosen frequency. The monthly choice and the
// weekly weekdays are anchored on the event's start when the rule is built (lib `editableToRule`), so
// the UI shows the pattern type, not the concrete weekday/date.
function RecurrenceEditor(props: {
  recurrence: EditableRecurrence;
  error: string | null;
  onChange: (patch: Partial<EditableRecurrence>) => void;
}): JSX.Element {
  const repeats = () => props.recurrence.frequency !== "";
  const unit = () => INTERVAL_UNIT[props.recurrence.frequency] ?? "time";
  function toggleWeekday(code: string, on: boolean) {
    const current = props.recurrence.weekdays;
    const next = on ? [...current, code] : current.filter((c) => c !== code);
    props.onChange({ weekdays: next });
  }
  return (
    <fieldset class="event-edit-recurrence">
      <legend class="event-edit-label">Repeat</legend>
      <select
        class="event-edit-input"
        aria-label="Repeat"
        value={props.recurrence.frequency}
        onChange={(e) =>
          props.onChange({ frequency: e.currentTarget.value as EditableRecurrence["frequency"] })
        }
      >
        <For each={FREQUENCY_OPTIONS}>
          {(opt) => <option value={opt.value}>{opt.label}</option>}
        </For>
      </select>

      <Show when={repeats()}>
        <label class="event-edit-field event-edit-interval">
          <span class="event-edit-label">Every</span>
          <input
            type="number"
            min="1"
            class="event-edit-input"
            aria-label="Repeat every"
            value={props.recurrence.interval}
            aria-invalid={props.recurrence.interval >= 1 ? undefined : "true"}
            onInput={(e) =>
              props.onChange({ interval: Math.trunc(Number(e.currentTarget.value)) || 0 })
            }
          />
          <span class="event-edit-unit">{unit()}(s)</span>
        </label>

        <Show when={props.recurrence.frequency === "weekly"}>
          {/* Native checkboxes; a fieldset (not role=group) groups them per biome's semantic rule. */}
          <fieldset class="event-edit-weekdays" aria-label="Repeat on">
            <For each={WEEKDAY_PICKER}>
              {(d) => (
                <label class="event-edit-weekday">
                  <input
                    type="checkbox"
                    checked={props.recurrence.weekdays.includes(d.code)}
                    onChange={(e) => toggleWeekday(d.code, e.currentTarget.checked)}
                  />
                  <span>{d.label}</span>
                </label>
              )}
            </For>
          </fieldset>
        </Show>

        <Show when={props.recurrence.frequency === "monthly"}>
          {/* Native radios share a `name`, so they form one radio group; a fieldset wraps them. */}
          <fieldset class="event-edit-monthly" aria-label="Monthly pattern">
            <label class="event-edit-check">
              <input
                type="radio"
                name="monthly-mode"
                checked={!props.recurrence.monthlyNth}
                onChange={() => props.onChange({ monthlyNth: false })}
              />
              <span>On this day of the month</span>
            </label>
            <label class="event-edit-check">
              <input
                type="radio"
                name="monthly-mode"
                checked={props.recurrence.monthlyNth}
                onChange={() => props.onChange({ monthlyNth: true })}
              />
              <span>On this weekday of the month</span>
            </label>
          </fieldset>
        </Show>

        <label class="event-edit-field">
          <span class="event-edit-label">Ends</span>
          <select
            class="event-edit-input"
            value={props.recurrence.end}
            onChange={(e) =>
              props.onChange({ end: e.currentTarget.value as EditableRecurrence["end"] })
            }
          >
            <option value="never">Never</option>
            <option value="count">After a number of times</option>
            <option value="until">On a date</option>
          </select>
        </label>

        <Show when={props.recurrence.end === "count"}>
          <label class="event-edit-field">
            <span class="event-edit-label">Occurrences</span>
            <input
              type="number"
              min="1"
              class="event-edit-input"
              value={props.recurrence.count}
              aria-invalid={props.recurrence.count >= 1 ? undefined : "true"}
              onInput={(e) =>
                props.onChange({ count: Math.trunc(Number(e.currentTarget.value)) || 0 })
              }
            />
          </label>
        </Show>
        <Show when={props.recurrence.end === "until"}>
          <label class="event-edit-field">
            <span class="event-edit-label">End date</span>
            <input
              type="date"
              class="event-edit-input"
              value={props.recurrence.until}
              aria-invalid={props.error ? "true" : undefined}
              onInput={(e) => props.onChange({ until: e.currentTarget.value })}
            />
          </label>
        </Show>
      </Show>

      <Show when={props.error}>
        {(message) => (
          <p class="event-edit-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </fieldset>
  );
}

// A JSCalendar enum <select> with a leading "Default" (unset) option. CSS-capitalizes the values, so
// the raw single-word vocabularies (confirmed/tentative/cancelled, free/busy, public/private/secret)
// read naturally without a label map.
function EnumField(props: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label class="event-edit-field">
      <span class="event-edit-label">{props.label}</span>
      <select
        class="event-edit-input event-edit-enum"
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <option value="">Default</option>
        <For each={props.options}>{(opt) => <option value={opt}>{opt}</option>}</For>
      </select>
    </label>
  );
}
