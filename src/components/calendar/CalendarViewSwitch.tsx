import { For } from "solid-js";
import type { CalendarViewMode } from "@/lib/calendar";
import { calendarViewMode, setCalendarViewMode } from "@/stores/ui";

/** The view modes in switch order, with their labels. The single source of truth for mode labels —
 * CalendarMain's placeholder reads it too, so a label rename / new mode lives in one place. */
export const MODES: { mode: CalendarViewMode; label: string }[] = [
  { mode: "agenda", label: "Agenda" },
  { mode: "day", label: "Day" },
  { mode: "week", label: "Week" },
  { mode: "month", label: "Month" },
];

/**
 * The in-surface Agenda · Day · Week · Month switch (a segmented toggle-button group) that picks which
 * calendar view the surface renders. Sets `calendarViewMode`; the Calendar surface re-queries the
 * visible window on the change. A toggle-button group (role="group" + per-button `aria-pressed`) rather
 * than a tab list — the panel it controls isn't a single tabpanel and the modes share one data source.
 */
export function CalendarViewSwitch() {
  return (
    <fieldset class="calendar-view-switch" aria-label="Calendar view">
      <For each={MODES}>
        {(m) => {
          const isActive = () => calendarViewMode() === m.mode;
          return (
            <button
              type="button"
              class="calendar-view-tab"
              classList={{ "is-active": isActive() }}
              aria-pressed={isActive()}
              onClick={() => setCalendarViewMode(m.mode)}
            >
              {m.label}
            </button>
          );
        }}
      </For>
    </fieldset>
  );
}
