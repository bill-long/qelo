import { createMemo, For, type JSX, Show } from "solid-js";
import type { CalendarEvent } from "@/jmap/types";
import {
  dayKey,
  eventDisplayTitle,
  formatDayHeading,
  formatTimeRange,
  recurrenceSummary,
} from "@/lib/calendar";
import { calendarEvents, calendars } from "@/stores/calendar";
import { selectedEventId } from "@/stores/ui";

/**
 * The event detail (column 3, where ThreadView sits in mail view): a focused-complete render of the
 * selected event — title, when (day + time range + time zone), calendar, location(s), description,
 * status/free-busy/privacy, participants (read-only), and a recurrence badge. Empty-state when no
 * event is selected. Read-only this milestone (edit/create/delete are Phase 2).
 */
export function EventView() {
  const event = () => {
    const id = selectedEventId();
    return id ? calendarEvents[id] : undefined;
  };
  return (
    <div class="event-view">
      <Show when={event()} fallback={<p class="event-empty">Select an event</p>}>
        {(e) => <EventDetail event={e()} />}
      </Show>
    </div>
  );
}

// A recurring base event carries its `recurrenceRule` (→ a prose summary); an expanded occurrence
// carries only `recurrenceId` (the rule lives on the base event, which the expanded query doesn't
// return), so it gets a generic marker. Null when the event doesn't recur.
function recurrenceText(event: CalendarEvent): string | null {
  return recurrenceSummary(event.recurrenceRule) ?? (event.recurrenceId ? "Repeating event" : null);
}

// The participant's best display label: name → bare email → a mailto:/imip sendTo address → null.
function participantLabel(p: {
  name?: string;
  email?: string;
  sendTo?: Record<string, string>;
}): string | null {
  const name = p.name?.trim();
  if (name) return name;
  const email = p.email?.trim();
  if (email) return email;
  const uri = p.sendTo ? Object.values(p.sendTo)[0] : undefined;
  return uri ? uri.replace(/^mailto:/i, "") : null;
}

function EventDetail(props: { event: CalendarEvent }) {
  const event = () => props.event;
  const title = createMemo(() => eventDisplayTitle(event()));
  const heading = createMemo(() => {
    const key = dayKey(event());
    return key ? formatDayHeading(key) : "";
  });
  const timeRange = createMemo(() => formatTimeRange(event()));
  const calendar = createMemo(() => {
    const ids = Object.keys(event().calendarIds ?? {});
    for (const id of ids) {
      const cal = calendars[id];
      if (cal) return cal;
    }
    return undefined;
  });
  const locations = createMemo(() =>
    Object.values(event().locations ?? {})
      .map((l) => l?.name?.trim())
      .filter((n): n is string => Boolean(n)),
  );
  const participants = createMemo(() =>
    Object.values(event().participants ?? {})
      .map((p) => (p ? participantLabel(p) : null))
      .filter((p): p is string => Boolean(p)),
  );
  const description = createMemo(() => event().description?.trim() ?? "");
  const recurrence = createMemo(() => recurrenceText(event()));
  // Status/free-busy/privacy badges — only the ones the server actually set.
  const badges = createMemo(() =>
    [event().status, event().freeBusyStatus, event().privacy].filter((b): b is string =>
      Boolean(b),
    ),
  );

  return (
    <article class="event-detail">
      <header class="event-detail-head">
        <h1 class="event-detail-title">{title()}</h1>
        <p class="event-detail-when">
          <Show when={heading()}>
            <span class="event-detail-date">{heading()}</span>
          </Show>
          <Show when={timeRange()}>
            <span class="event-detail-time">{timeRange()}</span>
          </Show>
          <Show when={event().timeZone}>{(tz) => <span class="event-detail-tz">{tz()}</span>}</Show>
        </p>
        <Show when={recurrence()}>{(text) => <p class="event-detail-recur">↻ {text()}</p>}</Show>
        <Show when={badges().length > 0}>
          <p class="event-detail-badges">
            <For each={badges()}>{(b) => <span class="event-badge">{b}</span>}</For>
          </p>
        </Show>
      </header>

      <DetailSection label="Calendar" when={Boolean(calendar())}>
        <Show when={calendar()}>
          {(cal) => (
            <span class="event-calendar">
              <Show when={cal().color}>
                {(color) => (
                  <span
                    class="calendar-swatch"
                    aria-hidden="true"
                    style={{ "background-color": color() }}
                  />
                )}
              </Show>
              {cal().name}
            </span>
          )}
        </Show>
      </DetailSection>

      <DetailSection label="Location" when={locations().length > 0}>
        <For each={locations()}>{(loc) => <p class="event-detail-line">{loc}</p>}</For>
      </DetailSection>

      <DetailSection label="Participants" when={participants().length > 0}>
        <For each={participants()}>{(p) => <p class="event-detail-line">{p}</p>}</For>
      </DetailSection>

      <DetailSection label="Description" when={description() !== ""}>
        <p class="event-description">{description()}</p>
      </DetailSection>
    </article>
  );
}

function DetailSection(props: { label: string; when: boolean; children: JSX.Element }) {
  return (
    <Show when={props.when}>
      <section class="event-detail-section">
        <h2 class="event-detail-label">{props.label}</h2>
        {props.children}
      </section>
    </Show>
  );
}
