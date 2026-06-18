import { createMemo, For, Show } from "solid-js";
import type { CalendarEvent } from "@/jmap/types";
import {
  eventDisplayTitle,
  formatTimeRange,
  groupEventsByDay,
  isAllDay,
  isRecurring,
} from "@/lib/calendar";
import { calendarEvents, calendarReady, eventIds } from "@/stores/calendar";
import { selectedCalendarId, selectedEventId, setSelectedEventId } from "@/stores/ui";

/**
 * The agenda body (the "agenda" view mode): the loaded date window's events, grouped by day with a
 * heading per day. The calendar load + window navigation are owned by the enclosing CalendarMain, so
 * this component is purely the agenda render of the current window.
 */
export function EventList() {
  // Resolve eventIds (query order) → events, filtered to the selected calendar (null = all), then
  // grouped by day. groupEventsByDay sorts within each day, so the agenda order is deterministic.
  const groups = createMemo(() => {
    const calId = selectedCalendarId();
    const events: CalendarEvent[] = [];
    for (const id of eventIds()) {
      const event = calendarEvents[id];
      if (!event) continue;
      if (calId !== null && event.calendarIds?.[calId] !== true) continue;
      events.push(event);
    }
    return groupEventsByDay(events);
  });

  return (
    <div class="agenda">
      <Show when={calendarReady()} fallback={<p class="agenda-note">Loading…</p>}>
        <Show
          when={groups().length > 0}
          fallback={<p class="agenda-note">No events in this range</p>}
        >
          <For each={groups()}>
            {(group) => (
              <section class="agenda-day">
                <h2 class="agenda-day-heading">{group.heading}</h2>
                <ul class="agenda-rows">
                  <For each={group.events}>{(event) => <EventRow id={event.id} />}</For>
                </ul>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function EventRow(props: { id: string }) {
  const event = () => calendarEvents[props.id];
  const isSelected = () => selectedEventId() === props.id;
  return (
    <Show when={event()}>
      {(e) => (
        <li>
          <button
            type="button"
            class="agenda-row"
            classList={{ "is-selected": isSelected(), "is-all-day": isAllDay(e()) }}
            aria-current={isSelected() ? "true" : undefined}
            onClick={() => setSelectedEventId(props.id)}
          >
            <span class="agenda-row-time">{formatTimeRange(e())}</span>
            <span class="agenda-row-title">
              {eventDisplayTitle(e())}
              <Show when={isRecurring(e())}>
                <span
                  class="agenda-row-recur"
                  role="img"
                  aria-label="Repeating event"
                  title="Repeating event"
                >
                  {" ↻"}
                </span>
              </Show>
            </span>
          </button>
        </li>
      )}
    </Show>
  );
}
