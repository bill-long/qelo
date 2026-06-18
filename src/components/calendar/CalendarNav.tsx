import { rangeLabel, stepAnchor, todayAnchor } from "@/lib/calendar";
import { calendarAnchor, calendarViewMode, setCalendarAnchor } from "@/stores/ui";

/**
 * The window navigation header: ‹ Prev / Today / Next › plus a label for the visible range ("June
 * 2026", "Jun 15 – 21", "Wed, Jun 17"). Prev/Next step the anchor one view-window (month/week/day/
 * agenda-roll) via `stepAnchor`; Today resets it to the current day. Navigation is unbounded — each
 * step moves the anchor and the surface re-queries that (small) window. The range label is an
 * `aria-live` region so a keyboard/AT user hears the new range after navigating.
 */
export function CalendarNav() {
  const label = () => rangeLabel(calendarViewMode(), calendarAnchor());
  const step = (dir: 1 | -1) => setCalendarAnchor((a) => stepAnchor(calendarViewMode(), a, dir));
  return (
    <div class="calendar-nav">
      <button
        type="button"
        class="calendar-nav-step"
        aria-label="Previous"
        onClick={() => step(-1)}
      >
        <span aria-hidden="true">‹</span>
      </button>
      <button
        type="button"
        class="calendar-nav-today"
        onClick={() => setCalendarAnchor(todayAnchor())}
      >
        Today
      </button>
      <button type="button" class="calendar-nav-step" aria-label="Next" onClick={() => step(1)}>
        <span aria-hidden="true">›</span>
      </button>
      <span class="calendar-nav-label" aria-live="polite">
        {label()}
      </span>
    </div>
  );
}
