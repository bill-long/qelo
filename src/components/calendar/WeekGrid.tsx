import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { CalendarEvent } from "@/jmap/types";
import {
  type AllDaySegment,
  type DayPlacement,
  dayKey,
  eventAccessibleName,
  eventDayPlacement,
  eventDisplayTitle,
  formatDayHeading,
  formatTimeRange,
  isRecurring,
  layoutAllDayLane,
  MINUTES_PER_DAY,
  nowIndicatorOffset,
  type PackedPlacement,
  packDayColumns,
  weekDays,
} from "@/lib/calendar";
import { calendarReady, selectedCalendarEvents } from "@/stores/calendar";
import { calendarAnchor, selectedEventId, setSelectedEventId } from "@/stores/ui";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
// First hour scrolled into view (~working hours) so the grid doesn't open pinned at midnight.
const DEFAULT_SCROLL_HOUR = 7;
// Floor a block's rendered height so a short/zero-duration event stays clickable (the layout height is
// exact; this is purely a visual minimum, applied as a CSS min-height, not in the pure helper).
const MIN_BLOCK_MINUTES = 24;

function pct(minutes: number): string {
  return `${(minutes / MINUTES_PER_DAY) * 100}%`;
}

/**
 * The week/day time-grid view: an hour axis with `columns` day columns (7 for week, 1 for day — Day is
 * just this component with a single column), an all-day lane of clipped bars across the top, timed
 * events placed by start-offset + duration and overlap-packed side-by-side, and a current-time line on
 * today's column. Shares its event source with the agenda + month grid (selectedCalendarEvents). The
 * calendar load + window navigation are owned by CalendarMain; this is purely the time-grid render of
 * the current window. Clicking a block selects the event → the slide-over detail.
 */
export function WeekGrid(props: { columns: number }) {
  const days = createMemo(() => weekDays(calendarAnchor(), props.columns));
  // The window's events filtered once (shared by the all-day lane + every day column) rather than each
  // column re-filtering selectedCalendarEvents over all eventIds.
  const events = createMemo(() => selectedCalendarEvents());
  const allDaySegments = createMemo(() => layoutAllDayLane(events(), days()));

  // A minute-ticking clock drives the now-indicator (and the today-column highlight). A long-lived
  // setInterval cleared in onCleanup — no direct DOM writes, the signal flows through the render.
  const [now, setNow] = createSignal(new Date());
  const timer = setInterval(() => setNow(new Date()), 60_000);
  onCleanup(() => clearInterval(timer));

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
        <div class="week-scroll" ref={scrollRef}>
          <div class="week-sticky">
            <div class="week-head" style={{ "grid-template-columns": template() }}>
              <div class="week-corner" aria-hidden="true" />
              <div class="week-head-days" style={{ "grid-template-columns": cols() }}>
                <For each={days()}>
                  {(key) => (
                    <div
                      class="week-head-day"
                      classList={{ "is-today": nowIndicatorOffset(now(), key) !== null }}
                    >
                      {formatDayHeading(key)}
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
            <div class="week-cols" style={{ "grid-template-columns": cols() }}>
              <For each={days()}>
                {(key) => <WeekDayColumn dayKey={key} now={now} events={events} />}
              </For>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

function AllDayBar(props: { seg: AllDaySegment }) {
  const event = () => props.seg.event;
  const isSelected = () => selectedEventId() === event().id;
  // A bar can span several columns; name it by its start day (formatTimeRange carries the full span).
  const name = createMemo(() => eventAccessibleName(event(), dayKey(event())));
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

function WeekDayColumn(props: { dayKey: string; now: () => Date; events: () => CalendarEvent[] }) {
  // Timed events placed in this column, overlap-packed into side-by-side sub-columns.
  const blocks = createMemo<PackedPlacement[]>(() => {
    const placements: DayPlacement[] = [];
    for (const e of props.events()) {
      const p = eventDayPlacement(e, props.dayKey);
      if (p) placements.push(p);
    }
    return packDayColumns(placements);
  });
  const nowOffset = () => nowIndicatorOffset(props.now(), props.dayKey);
  return (
    <div class="week-col">
      <For each={blocks()}>{(block) => <TimedBlock block={block} dayKey={props.dayKey} />}</For>
      <Show when={nowOffset() !== null}>
        <div class="week-now" aria-hidden="true" style={{ top: pct(nowOffset() ?? 0) }}>
          <span class="week-now-dot" />
        </div>
      </Show>
    </div>
  );
}

function TimedBlock(props: { block: PackedPlacement; dayKey: string }) {
  const event = () => props.block.event;
  const isSelected = () => selectedEventId() === event().id;
  // Name the block by the COLUMN's day (props.dayKey), so a midnight-crossing event's later-day piece
  // announces the day it's drawn on, not the event's start day.
  const name = createMemo(() => eventAccessibleName(event(), props.dayKey));
  return (
    <button
      type="button"
      class="week-event"
      classList={{ "is-selected": isSelected() }}
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
      onClick={() => setSelectedEventId(event().id)}
    >
      <span class="week-event-time">{formatTimeRange(event())}</span>
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
