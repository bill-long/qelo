import { createMemo, For, Show } from "solid-js";
import type { CalendarEvent } from "@/jmap/types";
import {
  type DayCell,
  dayKey,
  eventCoversDays,
  eventDisplayTitle,
  formatDayHeading,
  formatTimeRange,
  isRecurring,
  layoutMonth,
  MONTH_VISIBLE_LANES,
  type MonthSegment,
  type MonthWeekLayout,
  monthGridWeeks,
} from "@/lib/calendar";
import { calendarReady, selectedCalendarEvents } from "@/stores/calendar";
import {
  calendarAnchor,
  selectedEventId,
  setCalendarAnchor,
  setCalendarViewMode,
  setSelectedEventId,
} from "@/stores/ui";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EMPTY_LAYOUT: MonthWeekLayout = { segments: [], overflow: [0, 0, 0, 0, 0, 0, 0] };

// A local-midnight Date for a "YYYY-MM-DD" cell key — the anchor when drilling into a day.
function keyToAnchor(key: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}

// A self-describing accessible name for an event button: title + when. The month grid is a visual
// layout (no ARIA grid navigation — the agenda is the linear accessible equivalent, same posture as
// the time-grid), so each event must name its own day: a single-day event prepends the day heading
// (formatTimeRange gives only times / "All day"); a multi-day span's formatTimeRange already carries
// its dates.
function eventAccessibleName(e: CalendarEvent): string {
  const parts = [eventDisplayTitle(e)];
  if (eventCoversDays(e).length === 1) parts.push(formatDayHeading(dayKey(e)));
  const range = formatTimeRange(e);
  if (range) parts.push(range);
  return parts.join(", ");
}

/**
 * The month view: a Sun-start day-cell grid for the anchor's month (adjacent-month days dimmed,
 * today ringed), with single-day event chips and multi-day/all-day bars laid into collision-free lanes
 * by {@link layoutMonth}, and a "+N more" overflow that opens that day. Shares its event source with the
 * agenda (selectedCalendarEvents — filtered to the selected calendar). The calendar load + window
 * navigation are owned by the enclosing CalendarMain, so this is purely the month render.
 */
export function MonthGrid() {
  // Zip weeks with their layout so a row carries both (same length — layoutMonth maps over weeks).
  const rows = createMemo(() => {
    const weeks = monthGridWeeks(calendarAnchor());
    const layouts = layoutMonth(selectedCalendarEvents(), weeks);
    return weeks.map((week, i) => ({ week, layout: layouts[i] ?? EMPTY_LAYOUT }));
  });

  return (
    <div class="month-grid">
      <Show when={calendarReady()} fallback={<p class="agenda-note">Loading…</p>}>
        {/* Weekday labels are decorative — each event button names its own day (eventAccessibleName),
            so they're hidden from AT to avoid a stream of unassociated header text. */}
        <div class="month-weekdays" aria-hidden="true">
          <For each={WEEKDAY_LABELS}>{(label) => <span class="month-weekday">{label}</span>}</For>
        </div>
        <div class="month-weeks">
          <For each={rows()}>{(row) => <MonthWeek week={row.week} layout={row.layout} />}</For>
        </div>
      </Show>
    </div>
  );
}

function MonthWeek(props: { week: DayCell[]; layout: MonthWeekLayout }) {
  // Until the day time-grid lands (Branch C), revealing a day's hidden events opens the AGENDA anchored
  // at that day (which is built and lists the day's events) rather than the not-yet-built day view.
  function openDay(key: string) {
    setCalendarAnchor(keyToAnchor(key));
    setCalendarViewMode("agenda");
  }
  return (
    <div class="month-week">
      <div class="month-week-cells">
        <For each={props.week}>
          {(cell) => (
            <div
              class="month-cell"
              classList={{ "is-outside": !cell.inMonth, "is-today": cell.isToday }}
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
        <For each={props.layout.segments}>{(seg) => <MonthSegmentView seg={seg} />}</For>
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
                  aria-label={`${more()} more event${more() === 1 ? "" : "s"}, ${formatDayHeading(cell.key)}`}
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

function MonthSegmentView(props: { seg: MonthSegment }) {
  const event = () => props.seg.event;
  const isSelected = () => selectedEventId() === event().id;
  const name = createMemo(() => eventAccessibleName(event()));
  return (
    <button
      type="button"
      class="month-event"
      classList={{
        "is-bar": props.seg.isSpan,
        "is-chip": !props.seg.isSpan,
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
      <Show when={!props.seg.isSpan}>
        <span class="month-event-time">{formatTimeRange(event())}</span>
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
