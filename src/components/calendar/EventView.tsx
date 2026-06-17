import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { EventEditForm } from "@/components/calendar/EventEditForm";
import type { CalendarEvent } from "@/jmap/types";
import {
  dayKey,
  eventDisplayTitle,
  eventMayWrite,
  formatDayHeading,
  formatTimeRange,
  recurrenceSummary,
  writableCalendars,
} from "@/lib/calendar";
import { handleAuthFailure } from "@/stores/account";
import { calendarEvents, calendars, resolveBaseEvent } from "@/stores/calendar";
import { creatingEvent, selectedEventId, setCreatingEvent } from "@/stores/ui";

/**
 * The event detail (column 3, where ThreadView sits in mail view): a focused-complete render of the
 * selected event — title, when (day + time range + time zone), calendar, location(s), description,
 * status/free-busy/privacy, participants (read-only), and a recurrence badge. Empty-state when no
 * event is selected. An Edit affordance (gated on the event's calendar granting write rights) resolves
 * the BASE event behind the selected occurrence and swaps in {@link EventEditForm} in place;
 * create + delete are later Phase-2 branches. Recurrence + participant editing stay deferred.
 */
export function EventView() {
  const [editing, setEditing] = createSignal(false);
  // The resolved base event the form edits (an expanded occurrence's `id` is synthetic and can't be
  // updated — resolveBaseEvent maps it to the editable base event), paired with the synthetic
  // occurrence id it was resolved FROM. The pair is captured together so the form's edit target and
  // optimistic-overlay target can't drift apart across the async resolve (see handleEdit). Null until
  // resolved.
  const [editBase, setEditBase] = createSignal<CalendarEvent | null>(null);
  const [editOccurrenceId, setEditOccurrenceId] = createSignal<string | null>(null);
  const [resolving, setResolving] = createSignal(false);
  const [resolveError, setResolveError] = createSignal<string | null>(null);
  // Monotonic token identifying the latest resolve. A resolve superseded by a newer one (the user
  // re-clicked Edit, possibly on a different event) must not touch shared edit state when it finally
  // settles — in particular its `finally` must not clear `resolving` out from under the newer resolve.
  let resolveSeq = 0;
  const event = () => {
    const id = selectedEventId();
    return id ? calendarEvents[id] : undefined;
  };
  // Leave edit AND create mode whenever the selected event changes or clears, so a stale form can't
  // outlive its context (runs once on mount setting false, harmless). A successful create selects the
  // new occurrence, which lands here and closes the create form onto the new event's detail. Edit
  // state is component-local; `creatingEvent` is global, so it also gets an onCleanup below.
  createEffect(
    on(selectedEventId, () => {
      setEditing(false);
      setEditBase(null);
      setEditOccurrenceId(null);
      setResolveError(null);
      setCreatingEvent(false);
      // Also clear the in-flight flag: a resolve for the PREVIOUS selection may still be awaiting (its
      // own continuation aborts via the selectedEventId guard), but leaving `resolving` true would
      // wrongly disable + "Opening…" the newly selected event's Edit button until that old call returns.
      setResolving(false);
    }),
  );
  // Clear the create form when the Calendar surface unmounts (the view switch swaps it out when
  // activeView leaves "calendar"), so a half-filled create can't silently resurface on return —
  // `creatingEvent` is global UI state, unlike the component-local `editing`. Mirrors ContactView.
  onCleanup(() => setCreatingEvent(false));

  async function handleEdit() {
    const id = selectedEventId();
    if (!id) return;
    const token = ++resolveSeq;
    setResolveError(null);
    setResolving(true);
    try {
      const base = await resolveBaseEvent(id);
      // Bail if this resolve was superseded (a newer Edit click) or the selection moved on during the
      // await — either way, don't open the form seeded from `id` (which would edit one event while
      // overlaying another's occurrence) and don't surface a stale result.
      if (token !== resolveSeq || selectedEventId() !== id) return;
      if (base) {
        setEditBase(base);
        setEditOccurrenceId(id);
        setEditing(true);
      } else {
        setResolveError("Couldn't open this event for editing. It may have been deleted.");
      }
    } catch (err) {
      if (token !== resolveSeq) return; // superseded — let the newer resolve own the outcome
      // resolveBaseEvent issues raw requests, so an auth failure surfaces here — raise the global
      // re-auth gate (global, so regardless of the current selection) and stay on the detail.
      if (handleAuthFailure(err)) return;
      console.error("resolveBaseEvent failed:", err);
      // Only surface the inline error if the user is still on the event they tried to edit — a
      // selection change during the await means this banner would otherwise land on a different event.
      if (selectedEventId() === id) {
        setResolveError("Couldn't open this event for editing. Please try again.");
      }
    } finally {
      // Only the latest resolve clears the in-flight flag — a superseded one must not re-enable the
      // Edit button while the newer resolve is still running.
      if (token === resolveSeq) setResolving(false);
    }
  }

  return (
    <div class="event-view">
      <Show
        when={creatingEvent()}
        fallback={
          <Show when={event()} fallback={<p class="event-empty">Select an event</p>}>
            {(e) => (
              <Show
                when={editing() && editBase()}
                fallback={
                  <EventDetail
                    event={e()}
                    canEdit={eventMayWrite(e(), calendars)}
                    resolving={resolving()}
                    resolveError={resolveError()}
                    onEdit={() => void handleEdit()}
                  />
                }
              >
                {(base) => (
                  <EventEditForm
                    mode="edit"
                    event={base()}
                    occurrenceId={editOccurrenceId() as string}
                    onClose={() => {
                      setEditing(false);
                      setEditBase(null);
                      setEditOccurrenceId(null);
                    }}
                  />
                )}
              </Show>
            )}
          </Show>
        }
      >
        <EventEditForm
          mode="create"
          calendars={writableCalendars(calendars)}
          onClose={() => setCreatingEvent(false)}
        />
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

function EventDetail(props: {
  event: CalendarEvent;
  canEdit: boolean;
  resolving: boolean;
  resolveError: string | null;
  onEdit: () => void;
}) {
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
        <div class="event-detail-headline">
          <h1 class="event-detail-title">{title()}</h1>
          <Show when={props.canEdit}>
            <button
              type="button"
              class="event-edit-button"
              disabled={props.resolving}
              onClick={() => props.onEdit()}
            >
              {props.resolving ? "Opening…" : "Edit"}
            </button>
          </Show>
        </div>
        <Show when={props.resolveError}>
          {(message) => (
            <p class="event-edit-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
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
