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
  eventMayDelete,
  eventMayWrite,
  formatDayHeading,
  formatTimeRange,
  isRecurring,
  recurrenceSummary,
  writableCalendars,
} from "@/lib/calendar";
import { handleAuthFailure } from "@/stores/account";
import { calendarEvents, calendars, deleteEvent, resolveBaseEvent } from "@/stores/calendar";
import { notify } from "@/stores/toasts";
import { creatingEvent, selectedEventId, setCreatingEvent, setSelectedEventId } from "@/stores/ui";

/**
 * The event detail, re-homed (Calendar Views milestone) from the fixed column-3 pane into a modal
 * slide-over over the now-full-width calendar surface — so the month grid (and the week/day time-grid)
 * can span the freed columns. A native `<dialog>` opened with `showModal()` (the composer's pattern)
 * gives real modal semantics for free — focus trapped inside, background inert to AT, Escape→cancel,
 * `::backdrop` — rather than bolting a partial trap onto a div. Mounted only while an event is selected
 * or the create form is open; closing clears the selection / create mode.
 *
 * Inside: a focused-complete render of the selected event — title, when (day + time range + time zone),
 * calendar, location(s), description, status/free-busy/privacy, participants (read-only), recurrence
 * badge — with Edit (resolves the BASE event behind the selected occurrence → {@link EventEditForm}),
 * Delete (two-step confirm), and the create form (via `creatingEvent`). Editing a recurring event's
 * rule via the form changes the WHOLE series (the per-occurrence apply modes land in a later branch);
 * participant editing stays deferred.
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
  // A failed delete surfaces here, ABOVE the detail: deleteEvent prunes the occurrence optimistically,
  // so the EventDetail that hosted the Delete button unmounts the instant the delete is confirmed. On a
  // refusal the occurrence is restored + re-selected (the detail re-mounts) and this error rides down to
  // it as a prop. Held on the always-mounted EventView (not the unmounting detail) so it survives.
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  // In-flight guard for the delete. deleteEvent resolves the base id (a round trip) BEFORE the
  // optimistic prune unmounts the detail, so without this the confirm "Delete" stays clickable during
  // that window and a re-click would fire a second concurrent destroy + toast. Mirrors the Edit
  // affordance's `resolving` flag (which disables the Edit button). Owned by handleDelete's try/finally.
  const [deleting, setDeleting] = createSignal(false);
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
      // Also clear a stale delete error — a genuine selection change drops it; the null→same-id churn
      // of a refused delete's restore re-runs this BEFORE handleDelete sets the error, so the error
      // still wins (same ordering as ContactView).
      setDeleteError(null);
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

  async function handleDelete(occurrenceId: string) {
    if (deleting()) return; // re-entry guard (the confirm stays mounted during the base-id resolve)
    setDeleteError(null);
    setDeleting(true);
    let result: Awaited<ReturnType<typeof deleteEvent>>;
    try {
      result = await deleteEvent(occurrenceId);
    } finally {
      setDeleting(false);
    }
    if (result.ok) {
      notify("Event deleted");
      return;
    }
    // The auth case raises the global re-auth gate — say nothing here.
    if (result.reason === "auth") return;
    // deleteEvent resolves the base id asynchronously before acting, so the selection can have drifted
    // by the time it returns (a refusal restores + re-selects the occurrence ONLY if nothing else was
    // selected meanwhile). Surface the inline error only if the user is still on the event they tried to
    // delete — else this banner would land on a different event's detail (the PR #34 drift guard).
    if (selectedEventId() !== occurrenceId) return;
    setDeleteError(
      result.reason === "refused"
        ? "The server refused the deletion. The calendar may be read-only, or the event may have changed elsewhere."
        : result.reason === "unresolved"
          ? // null base resolution: already destroyed elsewhere OR a suffix-collision the resolver
            // couldn't narrow to one base — cover both rather than assert it's gone.
            "Couldn't delete this event — it may have already been deleted, or couldn't be uniquely identified. Please try again."
          : "Couldn't delete the event. Please try again.",
    );
  }

  // The slide-over is open while the create form is up OR a selected event actually resolves to a
  // loaded record — NOT merely a non-null `selectedEventId`. The nav signals persist across a window
  // change, so a selection can outlive the window that held it (a sync/nav reconcile prunes the event);
  // gating on `event()` means the modal auto-closes then instead of popping an empty "Select an event"
  // panel over the grid.
  let dialogRef: HTMLDialogElement | undefined;
  const open = () => creatingEvent() || Boolean(event());
  function close() {
    // close() the native dialog FIRST so the browser restores focus to the element that opened it (the
    // grid chip / agenda row), then clear the signals (which unmounts the now-closed dialog via Show).
    // Guard on `open` so this is a single, well-defined close (the dialog may already be closed on some
    // paths) — close() is the one place that closes, paired with the cancel handler's preventDefault.
    if (dialogRef?.open) dialogRef.close();
    setCreatingEvent(false);
    setSelectedEventId(null);
  }
  // Promote to the modal top layer when it opens, but only if it isn't ALREADY open: this effect
  // re-runs whenever any signal in open() changes (e.g. opening the create form while an event is
  // selected), and showModal() on an open <dialog> throws InvalidStateError — the `!dialogRef.open`
  // guard makes the re-run a no-op. Escape fires the dialog's native `cancel`, routed through close().
  createEffect(() => {
    if (open() && dialogRef && !dialogRef.open) dialogRef.showModal();
  });

  return (
    <Show when={open()}>
      <dialog
        ref={dialogRef}
        class="event-slideover"
        aria-label={creatingEvent() ? "New event" : "Event details"}
        onCancel={(e) => {
          // Escape: stop the browser's default close so this component is the single closer (close()
          // runs dialogRef.close() + clears the signals), matching the composer's ownership pattern.
          e.preventDefault();
          close();
        }}
      >
        <button
          type="button"
          class="event-slideover-close"
          aria-label="Close"
          onClick={() => close()}
        >
          <span aria-hidden="true">×</span>
        </button>
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
                        canDelete={eventMayDelete(e(), calendars)}
                        resolving={resolving()}
                        resolveError={resolveError()}
                        deleteError={deleteError()}
                        deleting={deleting()}
                        onEdit={() => void handleEdit()}
                        onDelete={(id) => void handleDelete(id)}
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
      </dialog>
    </Show>
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
  canDelete: boolean;
  resolving: boolean;
  resolveError: string | null;
  deleteError: string | null;
  deleting: boolean;
  onEdit: () => void;
  onDelete: (occurrenceId: string) => void;
}) {
  const event = () => props.event;
  // The inline two-step delete confirm (Bill's choice, the contacts Branch-5 pattern): the Delete
  // button swaps the header actions into a "Delete X? [Delete] [Cancel]" row. Component-local —
  // confirming, not the deletion itself; the confirm "Delete" hands off to onDelete (deleteEvent),
  // whose optimistic prune unmounts this detail. Reset when the displayed event changes so a half-armed
  // confirm can't carry to the next event (Show doesn't re-mount this between two truthy events, so
  // reset explicitly). Keyed on the synthetic occurrence id, which is the store/selection key.
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  createEffect(
    on(
      () => props.event.id,
      () => setConfirmingDelete(false),
    ),
  );
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
          <Show
            when={confirmingDelete()}
            fallback={
              <div class="event-detail-actions">
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
                <Show when={props.canDelete}>
                  <button
                    type="button"
                    class="event-delete-button"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete
                  </button>
                </Show>
              </div>
            }
          >
            <fieldset class="event-delete-confirm" aria-label="Confirm delete event">
              <span class="event-delete-prompt">
                Delete “{title()}”?
                <Show when={isRecurring(event())}>
                  <span class="event-delete-note">This deletes the whole repeating series.</span>
                </Show>
              </span>
              <button
                type="button"
                class="event-delete-button"
                disabled={props.deleting}
                onClick={() => props.onDelete(props.event.id)}
              >
                {props.deleting ? "Deleting…" : "Delete"}
              </button>
              <button
                type="button"
                class="event-delete-cancel"
                disabled={props.deleting}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </fieldset>
          </Show>
        </div>
        <Show when={props.resolveError}>
          {(message) => (
            <p class="event-edit-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={props.deleteError}>
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
