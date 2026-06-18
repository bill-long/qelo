import { createEffect, Match, on, onMount, Switch } from "solid-js";
import { CalendarNav } from "@/components/calendar/CalendarNav";
import { CalendarViewSwitch, MODES } from "@/components/calendar/CalendarViewSwitch";
import { EventList } from "@/components/calendar/EventList";
import { loadCalendar, refetchWindow } from "@/stores/calendar";
import { calendarAnchor, calendarViewMode } from "@/stores/ui";

// The active mode's label (from the switch's single source of truth), for the placeholder copy.
function modeLabel(): string {
  return MODES.find((m) => m.mode === calendarViewMode())?.label ?? "";
}

/**
 * The calendar surface's main column (where ThreadList sits in mail view): the view-mode switch + the
 * window-navigation header, over the body for the active view. This component owns the surface's data
 * lifecycle — it lazily loads the calendar on first open (idempotent; mail-only sessions never fetch)
 * and re-queries the visible window whenever the view mode or anchor changes (navigation). It stays
 * mounted across mode switches, so the load/nav wiring lives here rather than on the per-mode bodies.
 *
 * Agenda is live; Day/Week/Month render a placeholder this branch — the month grid and week/day
 * time-grid land in the following branches of the calendar-views milestone, replacing the placeholder.
 * (The default mode stays "agenda" until the month grid exists, so the default never lands on a
 * placeholder.) Navigation works in every mode, including the agenda's back/forward paging.
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
          <Match when={calendarViewMode() !== "agenda"}>
            <p class="agenda-note">
              {modeLabel()} view arrives later in this milestone. Use Agenda for now.
            </p>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
