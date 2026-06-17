import { createMemo, Show } from "solid-js";
import { writableCalendars } from "@/lib/calendar";
import { calendars } from "@/stores/calendar";
import { setCreatingEvent } from "@/stores/ui";

/**
 * The "+ New event" affordance in the calendar-view sidebar (mirrors mail's Compose / contacts'
 * New contact). It opens the create form over the detail pane (EventView reads `creatingEvent`).
 * Capability-gated: shown only when the account has at least one writable calendar
 * (`Calendar.myRights.mayWriteAll`/`mayWriteOwn`), so a read-only calendar account never offers a
 * create the server would refuse. Hidden until the calendars load (they arrive with the first
 * Calendar-view open), which is fine — there's nothing to create into before then.
 *
 * Only toggles `creatingEvent` — it does NOT touch the selection. The create form overlays the detail
 * pane via `Show` regardless of what's selected, so clearing the selection would be cosmetic; worse,
 * it would re-trigger EventView's `on(selectedEventId)` effect (which runs AFTER this batched handler)
 * and reset `creatingEvent` straight back to false — the contacts batched-handler trap. Leaving the
 * selection alone keeps the effect quiet, so the form actually opens.
 */
export function NewEventButton() {
  const canCreate = createMemo(() => writableCalendars(calendars).length > 0);
  return (
    <Show when={canCreate()}>
      <button type="button" class="compose-button" onClick={() => setCreatingEvent(true)}>
        <span aria-hidden="true">＋</span> New event
      </button>
    </Show>
  );
}
