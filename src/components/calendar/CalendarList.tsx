import { createMemo, For, Show } from "solid-js";
import { compareCalendars } from "@/lib/calendar";
import { calendars } from "@/stores/calendar";
import { selectedCalendarId, setSelectedCalendarId, setSelectedEventId } from "@/stores/ui";

/**
 * The calendar-view sidebar (column 1, where MailboxList sits in mail view): an "All calendars"
 * entry plus one row per calendar (with its color swatch). Selecting a calendar filters the agenda
 * to it; "All" (the null selection) shows every event. Mirrors AddressBookList's single-`<nav>`
 * landmark + row look.
 */
export function CalendarList() {
  const sorted = createMemo(() => Object.values(calendars).sort(compareCalendars));
  return (
    <nav class="calendar-list" aria-label="Calendars">
      <CalendarRow id={null} name="All calendars" color={null} />
      <For each={sorted()}>
        {(cal) => <CalendarRow id={cal.id} name={cal.name} color={cal.color} />}
      </For>
    </nav>
  );
}

function CalendarRow(props: { id: string | null; name: string; color: string | null }) {
  const isSelected = () => selectedCalendarId() === props.id;
  return (
    <button
      type="button"
      class="calendar-row"
      classList={{ "is-selected": isSelected() }}
      aria-current={isSelected() ? "true" : undefined}
      // Clear the open event when switching calendars — the previously-selected event may not be in
      // the newly-filtered agenda, which would leave the detail pane showing an event the list doesn't.
      onClick={() => {
        setSelectedCalendarId(props.id);
        setSelectedEventId(null);
      }}
    >
      <Show
        when={props.color}
        fallback={<span class="calendar-swatch is-empty" aria-hidden="true" />}
      >
        {(color) => (
          <span
            class="calendar-swatch"
            aria-hidden="true"
            style={{ "background-color": color() }}
          />
        )}
      </Show>
      <span class="calendar-name">{props.name}</span>
    </button>
  );
}
