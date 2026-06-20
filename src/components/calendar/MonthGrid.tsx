import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createClickSuppressor } from "@/components/calendar/clickSuppressor";
import { RescheduleScopeDialog } from "@/components/calendar/WeekGrid";
import type { CalendarEvent } from "@/jmap/types";
import {
  type DateParts,
  type DayCell,
  dayKey,
  dayKeyDelta,
  eventCoversDays,
  eventDisplayTitle,
  eventMayWrite,
  formatDayHeading,
  formatTimeRange,
  isRecurring,
  layoutMonth,
  MONTH_VISIBLE_LANES,
  type MonthSegment,
  type MonthWeekLayout,
  monthCellKey,
  monthGridWeeks,
  monthMoveStart,
  type RecurrenceEditMode,
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
  setCalendarAnchor,
  setCalendarViewMode,
  setSelectedEventId,
} from "@/stores/ui";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EMPTY_LAYOUT: MonthWeekLayout = { segments: [], overflow: [0, 0, 0, 0, 0, 0, 0] };
// Require this much pointer travel before a press on a chip/bar becomes a drag (below it the press is a
// click that selects the event) — matches the time-grid engine's threshold.
const DRAG_THRESHOLD_PX = 4;

// A local-midnight Date for a "YYYY-MM-DD" cell key — the anchor when drilling into a day.
function keyToAnchor(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}

// A self-describing accessible name for an event button: title + when. The month grid is a visual
// layout (no ARIA grid navigation — the agenda is the linear accessible equivalent, same posture as
// the time-grid), so each event must name its own day: a single-day event prepends the day heading
// (formatTimeRange gives only times / "All day"); a multi-day span's formatTimeRange already carries
// its dates. `zone` is the display zone — the day/time it names must match where the segment is drawn.
function eventAccessibleName(e: CalendarEvent, zone: string): string {
  const parts = [eventDisplayTitle(e)];
  if (eventCoversDays(e, zone).length === 1)
    parts.push(formatDayHeading(dayKey(e, zone), new Date(), zone));
  const range = formatTimeRange(e, zone);
  if (range) parts.push(range);
  return parts.join(", ");
}

// The in-progress drag of a month chip/bar (pointer engine state). A single component-local signal —
// naturally exclusive (one drag at a time) and cleared on every way the gesture ends (drop / Escape /
// pointercancel), so the highlight + dimmed source can't go stale (the PR #20 DnD lesson, here for
// Pointer Events). `grabKey` is the cell the press landed in; `hoverKey` the cell the pointer is over
// now — the move is their whole-day delta. `moved` flips once the press passes the threshold.
interface MonthDragState {
  occId: string;
  event: CalendarEvent;
  pointerId: number;
  startX: number;
  startY: number;
  grabKey: string;
  hoverKey: string;
  moved: boolean;
}

// A committed drop awaiting its write (and, for a recurring event, the scope choice). The dragged
// segment stays DIMMED and the target cell HIGHLIGHTED the whole time, so the chip doesn't snap back to
// its old cell while the reschedule round-trips / the user picks a scope.
interface MonthCommitting {
  occId: string;
  event: CalendarEvent;
  // The new start in the event's SOURCE zone (a whole-day shift of the source date — monthMoveStart).
  newStart: DateParts;
  // The display-zone cell the event was dropped on (the highlight target while the write is pending).
  targetKey: string;
  // The occurrence's recurrenceId (null for a non-recurring event, or a recurring occurrence without
  // one). The scope chooser shows whenever the EVENT is recurring (regardless of this), so a recurring
  // drag is never silently applied to the whole series.
  recurrenceId: string | null;
}

/**
 * The month view: a Sun-start day-cell grid for the anchor's month (adjacent-month days dimmed,
 * today ringed), with single-day event chips and multi-day/all-day bars laid into collision-free lanes
 * by {@link layoutMonth}, and a "+N more" overflow that opens that day. Shares its event source with the
 * agenda (selectedCalendarEvents — filtered to the selected calendar). The calendar load + window
 * navigation are owned by the enclosing CalendarMain, so this is purely the month render. DRAGGING a
 * chip/bar across cells reschedules the event by a whole-day delta (pointer engine below — a month move
 * is pure civil-day arithmetic, shifting the event's SOURCE start date; monthMoveStart), with a scope
 * chooser for a recurring series.
 */
export function MonthGrid() {
  const weeks = createMemo(() =>
    monthGridWeeks(calendarAnchor(), new Date(), calendarDisplayZone()),
  );
  // Zip weeks with their layout so a row carries both (same length — layoutMonth maps over weeks).
  const rows = createMemo(() => {
    const w = weeks();
    const layouts = layoutMonth(
      selectedCalendarEvents(),
      w,
      MONTH_VISIBLE_LANES,
      calendarDisplayZone(),
    );
    return w.map((week, i) => ({ week, layout: layouts[i] ?? EMPTY_LAYOUT }));
  });

  // --- Drag-to-move (pointer engine) ---------------------------------------
  const [monthDrag, setMonthDrag] = createSignal<MonthDragState | null>(null);
  const [committing, setCommitting] = createSignal<MonthCommitting | null>(null);
  const [dragError, setDragError] = createSignal<string | null>(null);
  // The `.month-weeks` container — its bounding rect maps a pointer to a cell (equal-height rows × 7).
  let weeksRef: HTMLDivElement | undefined;
  // Click-suppression for the trailing native `click` of a committed drag (a move must not also select);
  // the same shared primitive the time-grid engine uses (createClickSuppressor owns the macrotask
  // lifecycle that keeps the flag from swallowing a later keyboard activation).
  const clickSuppressor = createClickSuppressor();

  // Stable booleans so the window-listener effects re-run ONLY on an inactive↔active transition, not on
  // every pointermove (each move replaces the `monthDrag` object; a createMemo notifies only when its
  // boolean VALUE flips, so the effects don't thrash add/removeEventListener during a gesture).
  const isDragging = createMemo(() => monthDrag() !== null);
  const gestureActive = createMemo(() => monthDrag() !== null || committing() !== null);
  // The occurrence id currently being dragged/committed — its segment(s) dim so the highlight reads as
  // the live preview.
  const draggingId = createMemo(() => monthDrag()?.occId ?? committing()?.occId ?? null);
  // The SINGLE shared drop-target highlight (PR #20 exclusivity — no per-cell stale signal): the cell
  // under the pointer while dragging, else the committed target while the write/scope-choice is pending.
  const highlightKey = createMemo(() => {
    const d = monthDrag();
    if (d?.moved) return d.hoverKey;
    return committing()?.targetKey ?? null;
  });

  function startMonthDrag(event: CalendarEvent, e: PointerEvent): void {
    // Reset click-suppression at the START of every pointerdown — BEFORE any early return — so a prior
    // drag that ended without a trailing click can't leave it set and swallow the next click.
    clickSuppressor.reset();
    // Only a primary-button press on a writable event starts a drag; everything else stays a click. Also
    // refuse while a previous drop is still committing — its highlight/dim is pinned (and a recurring
    // scope chooser may be open); a new gesture would yank that away mid-write.
    if (e.button !== 0 || !weeksRef || committing() || !eventMayWrite(event, calendars)) return;
    const grabKey = monthCellKey(e.clientX, e.clientY, weeksRef.getBoundingClientRect(), weeks());
    if (!grabKey) return;
    setMonthDrag({
      occId: event.id,
      event,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabKey,
      hoverKey: grabKey,
      moved: false,
    });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function moveMonthDrag(e: PointerEvent): void {
    const d = monthDrag();
    if (!d || e.pointerId !== d.pointerId || !weeksRef) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX)
      return;
    const hoverKey = monthCellKey(e.clientX, e.clientY, weeksRef.getBoundingClientRect(), weeks());
    setMonthDrag({ ...d, moved: true, hoverKey: hoverKey ?? d.hoverKey });
  }

  function endMonthDrag(e: PointerEvent): void {
    const d = monthDrag();
    if (!d || e.pointerId !== d.pointerId) return;
    setMonthDrag(null);
    if (!d.moved) return; // a press that never moved → let the click select the event

    // The whole-day delta between the grabbed cell and the dropped cell. A malformed key (null) or a drop
    // back on the SAME cell (0) is a no-op — no write, and the trailing click selects.
    const delta = dayKeyDelta(d.grabKey, d.hoverKey);
    if (delta === null || delta === 0) return;
    // monthMoveStart shifts the event's SOURCE start date by the delta (keeping the time-of-day); null
    // only when the start is unparseable.
    const newStart = monthMoveStart(d.event, delta);
    if (!newStart) return;
    clickSuppressor.arm();
    const c: MonthCommitting = {
      occId: d.occId,
      event: d.event,
      newStart,
      targetKey: d.hoverKey,
      recurrenceId: d.event.recurrenceId ?? null,
    };
    setCommitting(c);
    // A RECURRING event always asks the scope (this/following/all) — never silently apply to the whole
    // series. A non-recurring event reschedules straight through ("all" = the single event).
    if (!isRecurring(d.event)) void dispatch(c, "all");
  }

  function cancelMonthDrag(e?: PointerEvent): void {
    const d = monthDrag();
    if (e && d && e.pointerId !== d.pointerId) return;
    setMonthDrag(null);
  }

  async function dispatch(c: MonthCommitting, mode: RecurrenceEditMode): Promise<void> {
    setDragError(null);
    // Boundary guard mirroring the dialog's disabled state: a per-occurrence mode needs a recurrenceId,
    // else saveEvent would degrade it to a whole-series "all" — so refuse rather than silently move the
    // whole series. (The dialog already aria-disables these, so this is defense-in-depth.)
    if (mode !== "all" && c.recurrenceId === null) {
      setCommitting(null);
      setDragError("Couldn't identify this occurrence. Try reopening the calendar.");
      return;
    }
    // A month move keeps the duration (null) — only the start date shifts.
    const res = await rescheduleEvent(c.occId, c.newStart, null, mode, c.recurrenceId);
    // Clear the held highlight/dim regardless — on success the reconcile re-rendered the segment in its
    // new cell; on failure the store reverted to server truth, so dropping the hold shows it unchanged.
    setCommitting(null);
    if (!res.ok && res.reason !== "auth") {
      setDragError(
        res.reason === "unresolved"
          ? "Couldn't identify this event's series. Try reopening the calendar."
          : "Couldn't reschedule the event. Please try again.",
      );
    }
  }

  // Pointer move/up/cancel live on WINDOW (bound only while a drag is live), not on the dragged chip:
  // the chip can unmount mid-drag (a coalesced sync prunes its row, or a nav re-lays the grid), which
  // would strand a chip-bound handler and leak the drag — the PR #20 "bind cleanup to something stable"
  // lesson. The effect's onCleanup also covers an unmount mid-drag; `pointercancel` (an OS/gesture
  // interruption) is handled alongside up so the drag can't stick open.
  createEffect(() => {
    if (!isDragging()) return;
    window.addEventListener("pointermove", moveMonthDrag);
    window.addEventListener("pointerup", endMonthDrag);
    window.addEventListener("pointercancel", cancelMonthDrag);
    onCleanup(() => {
      window.removeEventListener("pointermove", moveMonthDrag);
      window.removeEventListener("pointerup", endMonthDrag);
      window.removeEventListener("pointercancel", cancelMonthDrag);
    });
  });

  // Escape cancels an in-progress drag OR a pending scope choice (no write). A window listener only
  // while a gesture/commit is live, cleaned up on unmount.
  createEffect(() => {
    if (!gestureActive()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      cancelMonthDrag();
      setCommitting(null);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="month-grid">
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
        {/* Weekday labels are decorative — each event button names its own day (eventAccessibleName),
            so they're hidden from AT to avoid a stream of unassociated header text. */}
        <div class="month-weekdays" aria-hidden="true">
          <For each={WEEKDAY_LABELS}>{(label) => <span class="month-weekday">{label}</span>}</For>
        </div>
        <div class="month-weeks" ref={weeksRef}>
          <For each={rows()}>
            {(row) => (
              <MonthWeek
                week={row.week}
                layout={row.layout}
                highlightKey={highlightKey}
                draggingId={draggingId}
                onSegPointerDown={startMonthDrag}
                shouldSuppressClick={clickSuppressor.consume}
              />
            )}
          </For>
        </div>
        {/* A recurring commit shows the scope chooser (this/following/all); a non-recurring commit was
            dispatched directly in endMonthDrag. Reuses the time-grid's exact chooser (always "Move"). */}
        <Show
          when={(() => {
            const c = committing();
            return c && isRecurring(c.event) ? c : null;
          })()}
        >
          {(c) => (
            <RescheduleScopeDialog
              title={eventDisplayTitle(c().event)}
              action="move"
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

function MonthWeek(props: {
  week: DayCell[];
  layout: MonthWeekLayout;
  highlightKey: () => string | null;
  draggingId: () => string | null;
  onSegPointerDown: (event: CalendarEvent, e: PointerEvent) => void;
  shouldSuppressClick: () => boolean;
}) {
  // Revealing a day's hidden events drills into the Day time-grid anchored at that day — the natural
  // drill-down now that the day view exists (it replaced the agenda stand-in from Branch B).
  function openDay(key: string) {
    setCalendarAnchor(keyToAnchor(key));
    setCalendarViewMode("day");
  }
  return (
    <div class="month-week">
      <div class="month-week-cells">
        <For each={props.week}>
          {(cell) => (
            <div
              class="month-cell"
              classList={{
                "is-outside": !cell.inMonth,
                "is-today": cell.isToday,
                "is-drop-target": props.highlightKey() === cell.key,
              }}
            >
              <span class="month-cell-date" aria-current={cell.isToday ? "date" : undefined}>
                {cell.day}
              </span>
            </div>
          )}
        </For>
      </div>
      {/* The segments + "+N more" float over the cells in one 7-column lane grid below the date row,
          so a multi-day bar can span columns the per-cell flow can't, and the overflow row sits exactly
          below the visible lanes. <For> keys each segment by its (fresh, per-week) object reference, so
          a multi-day event appearing as a distinct segment in several weeks never collides. */}
      <div class="month-week-segments">
        <For each={props.layout.segments}>
          {(seg) => (
            <MonthSegmentView
              seg={seg}
              dimmed={props.draggingId() === seg.event.id}
              onPointerDown={props.onSegPointerDown}
              shouldSuppressClick={props.shouldSuppressClick}
            />
          )}
        </For>
        <For each={props.week}>
          {(cell, col) => {
            const more = () => props.layout.overflow[col()] ?? 0;
            return (
              <Show when={more() > 0}>
                <button
                  type="button"
                  class="month-more"
                  style={{
                    "grid-column": `${col() + 1}`,
                    "grid-row": `${MONTH_VISIBLE_LANES + 1}`,
                  }}
                  aria-label={`${more()} more event${more() === 1 ? "" : "s"}, ${formatDayHeading(cell.key, new Date(), calendarDisplayZone())}`}
                  onClick={() => openDay(cell.key)}
                >
                  +{more()} more
                </button>
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
}

function MonthSegmentView(props: {
  seg: MonthSegment;
  dimmed: boolean;
  onPointerDown: (event: CalendarEvent, e: PointerEvent) => void;
  shouldSuppressClick: () => boolean;
}) {
  const event = () => props.seg.event;
  const isSelected = () => selectedEventId() === event().id;
  const name = createMemo(() => eventAccessibleName(event(), calendarDisplayZone()));
  return (
    <button
      type="button"
      class="month-event"
      classList={{
        "is-bar": props.seg.isSpan,
        "is-chip": !props.seg.isSpan,
        "is-selected": isSelected(),
        "is-dragging": props.dimmed,
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
      onPointerDown={(e) => props.onPointerDown(event(), e)}
      onClick={() => {
        // Swallow the click that trails a committed drag (a move must not also select); a plain click
        // (no drag) selects as before.
        if (props.shouldSuppressClick()) return;
        setSelectedEventId(event().id);
      }}
    >
      <Show when={!props.seg.isSpan}>
        <span class="month-event-time">{formatTimeRange(event(), calendarDisplayZone())}</span>
      </Show>
      <span class="month-event-title">
        {eventDisplayTitle(event())}
        <Show when={isRecurring(event())}>
          <span class="month-event-recur" aria-hidden="true">
            {" ↻"}
          </span>
        </Show>
      </span>
    </button>
  );
}
