import { For } from "solid-js";
import { LOCAL_ZONE, rangeLabel, stepAnchor, todayAnchor } from "@/lib/calendar";
import {
  calendarAnchor,
  calendarDisplayZone,
  calendarViewMode,
  setCalendarAnchor,
  setCalendarDisplayZone,
} from "@/stores/ui";

// A curated set of common IANA zones for the display-zone picker — enough to cover the usual cases
// without the (very large) full tz database. Showing the FULL IANA list (a searchable combobox) is a
// tracked follow-up. The resolved browser zone (LOCAL_ZONE) is always added on top (deduped) and listed
// first, so the picker always offers the user's own zone even when it isn't in this curated set.
const COMMON_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Athens",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// LOCAL_ZONE first (the default + most relevant), then the curated zones with the local one filtered
// out so it isn't listed twice when it's already a common zone.
const BASE_ZONE_OPTIONS: string[] = [LOCAL_ZONE, ...COMMON_ZONES.filter((z) => z !== LOCAL_ZONE)];

// The options for a given active zone: the curated list, plus the active zone itself prepended when it
// isn't already one (so a controlled <select> ALWAYS has a matching <option> and can't render blank /
// silently misrepresent the active zone — e.g. if the signal is ever set to an off-list zone). With the
// default LOCAL_ZONE this is exactly BASE_ZONE_OPTIONS.
function zoneOptions(current: string): string[] {
  return BASE_ZONE_OPTIONS.includes(current) ? BASE_ZONE_OPTIONS : [current, ...BASE_ZONE_OPTIONS];
}

/**
 * The window navigation header: ‹ Prev / Today / Next › plus a label for the visible range ("June
 * 2026", "Jun 15 – 21", "Wed, Jun 17") and a display-zone picker. Prev/Next step the anchor one
 * view-window (month/week/day/agenda-roll) via `stepAnchor`; Today resets it to the current day IN THE
 * DISPLAY ZONE (so "Today" lands on the zone's date even when the browser is a day off). Navigation is
 * unbounded — each step moves the anchor and the surface re-queries that (small) window. The range
 * label is an `aria-live` region so a keyboard/AT user hears the new range after navigating.
 *
 * The zone `<select>` is bound to `calendarDisplayZone`: changing it re-derives the visible window
 * (CalendarMain watches the signal → `refetchWindow`, since a zone shift can move which days/events are
 * in view) and re-renders every grid/agenda/now-line in that zone. Default is the browser's local zone,
 * which reproduces the pre-picker rendering exactly. Floating + all-day events stay face value.
 */
export function CalendarNav() {
  const label = () =>
    rangeLabel(calendarViewMode(), calendarAnchor(), new Date(), calendarDisplayZone());
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
        onClick={() => setCalendarAnchor(todayAnchor(new Date(), calendarDisplayZone()))}
      >
        Today
      </button>
      <button type="button" class="calendar-nav-step" aria-label="Next" onClick={() => step(1)}>
        <span aria-hidden="true">›</span>
      </button>
      <span class="calendar-nav-label" aria-live="polite">
        {label()}
      </span>
      <select
        class="calendar-nav-zone"
        aria-label="Display time zone"
        value={calendarDisplayZone()}
        onChange={(e) => setCalendarDisplayZone(e.currentTarget.value)}
      >
        <For each={zoneOptions(calendarDisplayZone())}>
          {(zone) => <option value={zone}>{zone === LOCAL_ZONE ? `${zone} (local)` : zone}</option>}
        </For>
      </select>
    </div>
  );
}
