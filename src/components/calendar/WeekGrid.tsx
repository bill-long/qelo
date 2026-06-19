import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { CalendarEvent } from "@/jmap/types";
import {
  type AllDaySegment,
  type DateParts,
  type DayPlacement,
  dayKey,
  dropToSourceStart,
  eventAccessibleName,
  eventDayPlacement,
  eventDisplayTitle,
  eventMayWrite,
  eventStartParts,
  formatDayHeading,
  formatTimeRange,
  isRecurring,
  layoutAllDayLane,
  MINUTES_PER_DAY,
  nowIndicatorOffset,
  type PackedPlacement,
  packDayColumns,
  pointerToGrid,
  RECURRENCE_SCOPE_MODES,
  type RecurrenceEditMode,
  snapMinutes,
  weekDays,
} from "@/lib/calendar";
import {
  calendarReady,
  calendars,
  rescheduleEvent,
  selectedCalendarEvents,
} from "@/stores/calendar";
import {
  calendarAnchor,
  calendarDisplayZone,
  selectedEventId,
  setSelectedEventId,
} from "@/stores/ui";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
// First hour scrolled into view (~working hours) so the grid doesn't open pinned at midnight.
const DEFAULT_SCROLL_HOUR = 7;
// Floor a block's rendered height so a short/zero-duration event stays clickable (the layout height is
// exact; this is purely a visual minimum, applied as a CSS min-height, not in the pure helper).
const MIN_BLOCK_MINUTES = 24;
// Drag-to-reschedule: snap dropped times to a 15-minute grid (Bill's choice), and require this much
// pointer travel before a press becomes a drag (below it, the press is a click that selects the event).
const SNAP_MINUTES = 15;
const DRAG_THRESHOLD_PX = 4;

function pct(minutes: number): string {
  return `${(minutes / MINUTES_PER_DAY) * 100}%`;
}

// Whether two DateParts name the same wall-clock minute (seconds ignored — the grid snaps to minutes).
// Used to detect a drag dropped back where it started, so a non-move doesn't write or prompt.
function sameWhen(a: DateParts, b: DateParts | null): boolean {
  return (
    b !== null &&
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

// The in-progress drag (pointer engine state). A single component-local signal — naturally exclusive
// (one drag at a time) and cleared on every way the gesture ends (drop / Escape / pointercancel), so a
// ghost can't go stale (the PR #20 DnD lesson, here for Pointer Events). `moved` flips once the press
// passes the threshold, distinguishing a drag from a click.
interface DragState {
  occId: string;
  event: CalendarEvent;
  pointerId: number;
  startX: number;
  startY: number;
  grabOffsetMin: number; // pointer-minute − block-top-minute at grab, so the block doesn't jump
  durationMin: number;
  ghostDayKey: string;
  ghostTopMin: number;
  moved: boolean;
}

// A committed drop awaiting its write (and, for a recurring event, the scope choice). The ghost stays
// pinned at the dropped position the whole time, so the block doesn't snap back to its old slot while
// the reschedule round-trips / the user picks a scope.
interface Committing {
  occId: string;
  event: CalendarEvent;
  newStart: DateParts;
  ghostDayKey: string;
  ghostTopMin: number;
  durationMin: number;
  // The viewed occurrence's recurrenceId (null for a non-recurring event, or a recurring occurrence
  // without one). The scope chooser shows whenever the EVENT is recurring (regardless of this), so a
  // recurring drag is never silently applied to the whole series.
  recurrenceId: string | null;
}

/**
 * The week/day time-grid view: an hour axis with `columns` day columns (7 for week, 1 for day — Day is
 * just this component with a single column), an all-day lane of clipped bars across the top, timed
 * events placed by start-offset + duration and overlap-packed side-by-side, and a current-time line on
 * today's column. Shares its event source with the agenda + month grid (selectedCalendarEvents). The
 * calendar load + window navigation are owned by CalendarMain; this is purely the time-grid render of
 * the current window. Clicking a block selects the event → the slide-over detail; DRAGGING a block
 * reschedules it (pointer engine below) — a move writes the event's SOURCE start, converted back from
 * the display position (dropToSourceStart), with a scope chooser for a recurring series.
 */
export function WeekGrid(props: { columns: number }) {
  const days = createMemo(() => weekDays(calendarAnchor(), props.columns));
  // The window's events filtered once (shared by the all-day lane + every day column) rather than each
  // column re-filtering selectedCalendarEvents over all eventIds.
  const events = createMemo(() => selectedCalendarEvents());
  const allDaySegments = createMemo(() =>
    layoutAllDayLane(events(), days(), calendarDisplayZone()),
  );

  // A minute-ticking clock drives the now-indicator (and the today-column highlight). A long-lived
  // setInterval cleared in onCleanup — no direct DOM writes, the signal flows through the render.
  const [now, setNow] = createSignal(new Date());
  const timer = setInterval(() => setNow(new Date()), 60_000);
  onCleanup(() => clearInterval(timer));

  // --- Drag-to-reschedule (pointer engine) ---------------------------------
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const [committing, setCommitting] = createSignal<Committing | null>(null);
  const [dragError, setDragError] = createSignal<string | null>(null);
  let colsRef: HTMLDivElement | undefined;
  // Set true the instant a drag commits, so the trailing native `click` on the dragged block is
  // swallowed (a move must not also select). Read+reset by the block's onClick.
  let suppressClick = false;

  // The ghost (a translucent preview block) follows the pointer during a drag and stays pinned at the
  // drop while the write is in flight. One source for both phases so the rendering can't diverge.
  const ghost = createMemo(() => {
    const d = drag();
    if (d?.moved) {
      return {
        title: eventDisplayTitle(d.event),
        dayKey: d.ghostDayKey,
        topMin: d.ghostTopMin,
        durationMin: d.durationMin,
      };
    }
    const c = committing();
    if (c) {
      return {
        title: eventDisplayTitle(c.event),
        dayKey: c.ghostDayKey,
        topMin: c.ghostTopMin,
        durationMin: c.durationMin,
      };
    }
    return null;
  });
  // The occurrence id currently being dragged/committed — its real block dims so the ghost reads as the
  // live preview.
  const draggingId = createMemo(() => drag()?.occId ?? committing()?.occId ?? null);

  function startDrag(
    event: CalendarEvent,
    occId: string,
    e: PointerEvent,
    blockTopMin: number,
    blockHeightMin: number,
  ): void {
    // Only a primary-button press on a writable event starts a drag; everything else stays a click.
    // Also refuse while a previous drop is still committing — its ghost is pinned at the dropped slot
    // (and a recurring scope chooser may be open); a new drag would yank that ghost away mid-write.
    if (e.button !== 0 || !colsRef || committing() || !eventMayWrite(event, calendars)) return;
    // Reset the click-suppression flag at the START of every gesture, so a prior drag that ended
    // without a trailing click (released off any block) can't leave it set and swallow this gesture's
    // click. (pointerdown precedes the click, so clearing here is safe.)
    const rect = colsRef.getBoundingClientRect();
    const { colIndex, minutes } = pointerToGrid(e.clientX, e.clientY, rect, props.columns);
    const grabbedDay = days()[colIndex] ?? dayKey(event, calendarDisplayZone());
    // Only the event's START block initiates a drag. A midnight-crossing event renders a clipped block
    // in each covered column; the dropped position is treated as the event's NEW start, which is only
    // meaningful for the start block (a later piece's position maps to a different instant, so dragging
    // it would mis-set the start AND break the dropped-back no-op check). A non-start piece stays a click
    // (selects). B1 limitation: move a multi-day event from its first block; full delta-drag is deferred.
    if (grabbedDay !== dayKey(event, calendarDisplayZone())) return;
    // Reset the click-suppression flag at the START of every gesture, so a prior drag that ended without
    // a trailing click (released off any block) can't leave it set and swallow this gesture's click.
    // (pointerdown precedes the click, so clearing here is safe.)
    suppressClick = false;
    setDrag({
      occId,
      event,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabOffsetMin: minutes - blockTopMin,
      durationMin: blockHeightMin,
      ghostDayKey: grabbedDay,
      ghostTopMin: blockTopMin,
      moved: false,
    });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function moveDrag(e: PointerEvent): void {
    const d = drag();
    if (!d || e.pointerId !== d.pointerId || !colsRef) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX)
      return;
    const rect = colsRef.getBoundingClientRect();
    const g = pointerToGrid(e.clientX, e.clientY, rect, props.columns);
    // Keep the whole block within the day: clamp the top so it can't run past midnight at the bottom.
    const maxTop = Math.max(0, MINUTES_PER_DAY - d.durationMin);
    const topMin = Math.max(
      0,
      Math.min(maxTop, snapMinutes(g.minutes - d.grabOffsetMin, SNAP_MINUTES)),
    );
    setDrag({
      ...d,
      moved: true,
      ghostTopMin: topMin,
      ghostDayKey: days()[g.colIndex] ?? d.ghostDayKey,
    });
  }

  function endDrag(e: PointerEvent): void {
    const d = drag();
    if (!d || e.pointerId !== d.pointerId) return;
    setDrag(null);
    if (!d.moved) return; // a press that never moved → let the click select the event
    const newStart = dropToSourceStart(
      d.event,
      d.ghostDayKey,
      d.ghostTopMin,
      calendarDisplayZone(),
    );
    // Nothing to commit (malformed day, or dropped back at the current start) → let the click select.
    // Only SUPPRESS the trailing click once we actually commit a move, so a no-op drag still selects.
    if (!newStart || sameWhen(newStart, eventStartParts(d.event))) return;
    suppressClick = true;
    const c: Committing = {
      occId: d.occId,
      event: d.event,
      newStart,
      ghostDayKey: d.ghostDayKey,
      ghostTopMin: d.ghostTopMin,
      durationMin: d.durationMin,
      recurrenceId: d.event.recurrenceId ?? null,
    };
    setCommitting(c);
    // A RECURRING event always asks the scope (this/following/all) — never silently apply to the whole
    // series. A non-recurring event reschedules straight through ("all" = the single event).
    if (!isRecurring(d.event)) void dispatch(c, "all");
  }

  function cancelDrag(e?: PointerEvent): void {
    const d = drag();
    if (e && d && e.pointerId !== d.pointerId) return;
    setDrag(null);
  }

  async function dispatch(c: Committing, mode: RecurrenceEditMode): Promise<void> {
    setDragError(null);
    // Boundary guard mirroring the dialog's disabled state: a per-occurrence mode needs a recurrenceId,
    // else saveEvent would degrade it to a whole-series "all" — so refuse rather than silently move the
    // whole series. (The dialog already aria-disables these, so this is defense-in-depth.)
    if (mode !== "all" && c.recurrenceId === null) {
      setCommitting(null);
      setDragError("Couldn't identify this occurrence. Try reopening the calendar.");
      return;
    }
    const res = await rescheduleEvent(c.occId, c.newStart, null, mode, c.recurrenceId);
    // Clear the held ghost regardless — on success the reconcile re-rendered the block at its new slot;
    // on failure the store reverted to server truth, so dropping the ghost shows the unchanged block.
    setCommitting(null);
    if (!res.ok && res.reason !== "auth") {
      // Distinguish an un-resolvable base (the occurrence's series couldn't be identified) from a
      // generic failure, mirroring the edit/delete flows' specificity.
      setDragError(
        res.reason === "unresolved"
          ? "Couldn't identify this event's series. Try reopening the calendar."
          : "Couldn't reschedule the event. Please try again.",
      );
    }
  }

  // The pointer move/up/cancel handlers live on WINDOW (bound only while a drag is live), not on the
  // dragged block: the block can unmount mid-drag (a coalesced sync prunes its row), which would strand
  // a block-bound handler and leak the drag — the PR #20 "bind cleanup to something stable" lesson, here
  // for Pointer Events. The effect's onCleanup also covers an unmount mid-drag, and `pointercancel`
  // (an OS/gesture interruption) is handled alongside up so the drag can't stick open.
  createEffect(() => {
    if (!drag()) return;
    const move = (e: PointerEvent) => moveDrag(e);
    const up = (e: PointerEvent) => endDrag(e);
    const cancel = (e: PointerEvent) => cancelDrag(e);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    onCleanup(() => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    });
  });

  // Escape cancels an in-progress drag OR a pending scope choice (no write). A window listener only
  // while a gesture/commit is live, cleaned up on unmount.
  createEffect(() => {
    if (!drag() && !committing()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      cancelDrag();
      setCommitting(null);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  let scrollRef: HTMLDivElement | undefined;
  let canvasRef: HTMLDivElement | undefined;
  let didScroll = false;
  // Default-scroll to ~working hours once the grid is actually rendered. Gated on a createEffect (not
  // onMount) because the scroller lives inside <Show when={calendarReady()}>: on a cold open straight
  // into week/day the element doesn't exist at mount, so onMount would no-op and the grid would stay
  // pinned at 00:00. Scroll by a fraction of the CANVAS height (the 24h grid), NOT scrollHeight — that
  // includes the sticky header and would overshoot past the hour. Runs once (didScroll guard).
  createEffect(() => {
    if (didScroll || !calendarReady() || !scrollRef || !canvasRef) return;
    didScroll = true;
    scrollRef.scrollTop = (canvasRef.offsetHeight * DEFAULT_SCROLL_HOUR) / 24;
  });

  const template = () => `var(--week-axis-w) repeat(${props.columns}, minmax(0, 1fr))`;
  const cols = () => `repeat(${props.columns}, minmax(0, 1fr))`;

  return (
    <div class="week-grid">
      <Show when={calendarReady()} fallback={<p class="agenda-note">Loading…</p>}>
        <Show when={dragError()}>
          <div class="week-drag-error" role="alert">
            {dragError()}
            <button
              type="button"
              class="week-drag-error-dismiss"
              onClick={() => setDragError(null)}
            >
              Dismiss
            </button>
          </div>
        </Show>
        <div class="week-scroll" ref={scrollRef}>
          <div class="week-sticky">
            <div class="week-head" style={{ "grid-template-columns": template() }}>
              <div class="week-corner" aria-hidden="true" />
              <div class="week-head-days" style={{ "grid-template-columns": cols() }}>
                <For each={days()}>
                  {(key) => (
                    <div
                      class="week-head-day"
                      classList={{
                        "is-today": nowIndicatorOffset(now(), key, calendarDisplayZone()) !== null,
                      }}
                    >
                      {formatDayHeading(key, now(), calendarDisplayZone())}
                    </div>
                  )}
                </For>
              </div>
            </div>
            <div class="week-allday" style={{ "grid-template-columns": template() }}>
              <div class="week-allday-label" aria-hidden="true">
                All-day
              </div>
              <div class="week-allday-lane" style={{ "grid-template-columns": cols() }}>
                <For each={allDaySegments()}>{(seg) => <AllDayBar seg={seg} />}</For>
              </div>
            </div>
          </div>
          <div class="week-canvas" ref={canvasRef} style={{ "grid-template-columns": template() }}>
            <div class="week-axis" aria-hidden="true">
              <For each={HOURS}>
                {(h) => (
                  <div class="week-hour">
                    <span class="week-hour-label">{`${h < 10 ? "0" : ""}${h}:00`}</span>
                  </div>
                )}
              </For>
            </div>
            <div class="week-cols" ref={colsRef} style={{ "grid-template-columns": cols() }}>
              <For each={days()}>
                {(key) => (
                  <WeekDayColumn
                    dayKey={key}
                    now={now}
                    events={events}
                    draggingId={draggingId}
                    ghost={ghost}
                    onBlockPointerDown={startDrag}
                    shouldSuppressClick={() => {
                      const s = suppressClick;
                      suppressClick = false;
                      return s;
                    }}
                  />
                )}
              </For>
            </div>
          </div>
        </div>
        {/* A recurring commit shows the scope chooser (this/following/all); a non-recurring commit
            dispatched directly in endDrag, so its committing() has a non-recurring event. */}
        <Show
          when={(() => {
            const c = committing();
            return c && isRecurring(c.event) ? c : null;
          })()}
        >
          {(c) => (
            <RescheduleScopeDialog
              title={eventDisplayTitle(c().event)}
              recurrenceId={c().recurrenceId}
              onPick={(mode) => void dispatch(c(), mode)}
              onCancel={() => setCommitting(null)}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

// A native modal dialog asking how widely a recurring drag applies (this / following / all) — the same
// scope set as the edit + delete flows. Native <dialog> + showModal gives the focus-trap, inert
// background, and Escape→cancel for free (the established Qelo modal pattern).
function RescheduleScopeDialog(props: {
  title: string;
  recurrenceId: string | null;
  onPick: (mode: RecurrenceEditMode) => void;
  onCancel: () => void;
}) {
  let ref: HTMLDialogElement | undefined;
  createEffect(() => {
    const d = ref;
    if (d && !d.open && typeof d.showModal === "function") d.showModal();
  });
  return (
    <dialog
      ref={ref}
      class="drag-scope-dialog"
      aria-labelledby="drag-scope-heading"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="drag-scope-heading" class="drag-scope-heading">
        Move “{props.title}”
      </h2>
      <div class="drag-scope-actions">
        {/* "this"/"following" need the occurrence's recurrenceId; without one they're aria-disabled
            (focusable + a hint, the qelo-review-checklist disabled-state rule) and only "All events"
            fires — so a per-occurrence pick can't silently degrade to a whole-series move. */}
        <For each={RECURRENCE_SCOPE_MODES}>
          {(m) => {
            const disabled = () => m.value !== "all" && props.recurrenceId === null;
            return (
              <button
                type="button"
                class="drag-scope-mode"
                aria-disabled={disabled() ? "true" : undefined}
                onClick={() => {
                  if (disabled()) return;
                  props.onPick(m.value);
                }}
              >
                {m.label}
              </button>
            );
          }}
        </For>
        <Show when={props.recurrenceId === null}>
          <p class="drag-scope-hint">
            This occurrence couldn’t be identified, so only “All events” is available.
          </p>
        </Show>
        <button type="button" class="drag-scope-cancel" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

function AllDayBar(props: { seg: AllDaySegment }) {
  const event = () => props.seg.event;
  const isSelected = () => selectedEventId() === event().id;
  // A bar can span several columns; name it by its start day (formatTimeRange carries the full span).
  const name = createMemo(() =>
    eventAccessibleName(event(), dayKey(event(), calendarDisplayZone()), calendarDisplayZone()),
  );
  return (
    <button
      type="button"
      class="week-allday-bar"
      classList={{
        "is-selected": isSelected(),
        "continues-before": props.seg.continuesBefore,
        "continues-after": props.seg.continuesAfter,
      }}
      style={{
        "grid-column": `${props.seg.startCol + 1} / ${props.seg.endCol + 2}`,
        "grid-row": `${props.seg.lane + 1}`,
      }}
      aria-current={isSelected() ? "true" : undefined}
      aria-label={name()}
      title={name()}
      onClick={() => setSelectedEventId(event().id)}
    >
      {eventDisplayTitle(event())}
    </button>
  );
}

function WeekDayColumn(props: {
  dayKey: string;
  now: () => Date;
  events: () => CalendarEvent[];
  draggingId: () => string | null;
  ghost: () => { title: string; dayKey: string; topMin: number; durationMin: number } | null;
  onBlockPointerDown: (
    event: CalendarEvent,
    occId: string,
    e: PointerEvent,
    blockTopMin: number,
    blockHeightMin: number,
  ) => void;
  shouldSuppressClick: () => boolean;
}) {
  // Timed events placed in this column, overlap-packed into side-by-side sub-columns.
  const blocks = createMemo<PackedPlacement[]>(() => {
    const zone = calendarDisplayZone();
    const placements: DayPlacement[] = [];
    for (const e of props.events()) {
      const p = eventDayPlacement(e, props.dayKey, zone);
      if (p) placements.push(p);
    }
    // Pack against the rendered minimum height so short/zero-duration blocks that float to
    // MIN_BLOCK_MINUTES don't visually overlap while sharing a sub-column.
    return packDayColumns(placements, MIN_BLOCK_MINUTES, zone);
  });
  const nowOffset = () => nowIndicatorOffset(props.now(), props.dayKey, calendarDisplayZone());
  // The ghost shows in the column it's currently dropped over.
  const ghostHere = () => {
    const g = props.ghost();
    return g && g.dayKey === props.dayKey ? g : null;
  };
  return (
    <div class="week-col">
      <For each={blocks()}>
        {(block) => (
          <TimedBlock
            block={block}
            dayKey={props.dayKey}
            dimmed={props.draggingId() === block.event.id}
            onPointerDown={props.onBlockPointerDown}
            shouldSuppressClick={props.shouldSuppressClick}
          />
        )}
      </For>
      <Show when={ghostHere()}>
        {(g) => (
          <div
            class="week-event week-event-ghost"
            aria-hidden="true"
            style={{
              top: pct(g().topMin),
              height: pct(g().durationMin),
              "min-height": `${(MIN_BLOCK_MINUTES / MINUTES_PER_DAY) * 100}%`,
            }}
          >
            <span class="week-event-title">{g().title}</span>
          </div>
        )}
      </Show>
      <Show when={nowOffset() !== null}>
        <div class="week-now" aria-hidden="true" style={{ top: pct(nowOffset() ?? 0) }}>
          <span class="week-now-dot" />
        </div>
      </Show>
    </div>
  );
}

function TimedBlock(props: {
  block: PackedPlacement;
  dayKey: string;
  dimmed: boolean;
  onPointerDown: (
    event: CalendarEvent,
    occId: string,
    e: PointerEvent,
    blockTopMin: number,
    blockHeightMin: number,
  ) => void;
  shouldSuppressClick: () => boolean;
}) {
  const event = () => props.block.event;
  const isSelected = () => selectedEventId() === event().id;
  // Name the block by the COLUMN's day (props.dayKey), so a midnight-crossing event's later-day piece
  // announces the day it's drawn on, not the event's start day.
  const name = createMemo(() => eventAccessibleName(event(), props.dayKey, calendarDisplayZone()));
  return (
    <button
      type="button"
      class="week-event"
      classList={{ "is-selected": isSelected(), "is-dragging": props.dimmed }}
      style={{
        top: pct(props.block.top),
        height: pct(props.block.height),
        "min-height": `${(MIN_BLOCK_MINUTES / MINUTES_PER_DAY) * 100}%`,
        left: `${(props.block.column / props.block.columns) * 100}%`,
        width: `${(1 / props.block.columns) * 100}%`,
      }}
      aria-current={isSelected() ? "true" : undefined}
      aria-label={name()}
      title={name()}
      onPointerDown={(e) =>
        props.onPointerDown(event(), event().id, e, props.block.top, props.block.height)
      }
      onClick={() => {
        // Swallow the click that trails a committed drag (a move must not also select); a plain click
        // (no drag) selects as before.
        if (props.shouldSuppressClick()) return;
        setSelectedEventId(event().id);
      }}
    >
      <span class="week-event-time">{formatTimeRange(event(), calendarDisplayZone())}</span>
      <span class="week-event-title">
        {eventDisplayTitle(event())}
        <Show when={isRecurring(event())}>
          <span class="week-event-recur" aria-hidden="true">
            {" ↻"}
          </span>
        </Show>
      </span>
    </button>
  );
}
