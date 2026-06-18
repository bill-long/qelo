import { createEffect, Match, on, onMount, Switch } from "solid-js";
import { CalendarNav } from "@/components/calendar/CalendarNav";
import { CalendarViewSwitch } from "@/components/calendar/CalendarViewSwitch";
import { EventList } from "@/components/calendar/EventList";
import { MonthGrid } from "@/components/calendar/MonthGrid";
import { WeekGrid } from "@/components/calendar/WeekGrid";
import { loadCalendar, refetchWindow } from "@/stores/calendar";
import { calendarAnchor, calendarViewMode } from "@/stores/ui";

/**
 * The calendar surface's main column (where ThreadList sits in mail view): the view-mode switch + the
 * window-navigation header, over the body for the active view. This component owns the surface's data
 * lifecycle — it lazily loads the calendar on first open (idempotent; mail-only sessions never fetch)
 * and re-queries the visible window whenever the view mode or anchor changes (navigation). It stays
 * mounted across mode switches, so the load/nav wiring lives here rather than on the per-mode bodies.
 *
 * All four modes are live: Agenda (linear list), Month (day-cell grid), Week and Day (the hour-axis
 * time-grid — Day is WeekGrid with a single column). Month is the default landing (see stores/ui).
 * Navigation works in every mode, including the agenda's back/forward paging.
 */
export function CalendarMain() {
  // Lazy first load. loadCalendar is idempotent + never rejects, so firing it on mount is safe and a
  // mail⇄calendar toggle is cheap (the load-once guard short-circuits).
  onMount(() => void loadCalendar());
  // Re-query on a view-mode / anchor change. `defer: true` so the onMount load owns the FIRST fetch;
  // refetchWindow awaits that load internally, so a nav done before the load completes still wins.
  createEffect(on([calendarViewMode, calendarAnchor], () => void refetchWindow(), { defer: true }));

  return (
    <div class="calendar-main">
      <header class="calendar-bar">
        <CalendarViewSwitch />
        <CalendarNav />
      </header>
      <div class="calendar-body">
        <Switch>
          <Match when={calendarViewMode() === "agenda"}>
            <EventList />
          </Match>
          <Match when={calendarViewMode() === "month"}>
            <MonthGrid />
          </Match>
          {/* Week and Day share ONE WeekGrid (Day = a single column). One Match arm — not two — so
              toggling week↔day reactively re-columns the SAME instance instead of unmounting it,
              preserving the user's scroll position + the now-clock. */}
          <Match when={calendarViewMode() === "week" || calendarViewMode() === "day"}>
            <WeekGrid columns={calendarViewMode() === "day" ? 1 : 7} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}
