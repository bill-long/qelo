import { createMemo, Show } from "solid-js";
import { writableBooks } from "@/lib/contacts";
import { addressBooks } from "@/stores/contacts";
import { setCreatingContact } from "@/stores/ui";

/**
 * The "+ New contact" affordance in the contacts-view sidebar (mirrors mail's Compose button). It
 * opens the create form over the detail pane (ContactView reads `creatingContact`). Capability-gated:
 * shown only when the account has at least one writable address book (`AddressBook.myRights.mayWrite`),
 * so a read-only contacts account never offers a create that the server would refuse. Hidden until
 * the books load (they arrive with the first Contacts-view open), which is fine — there's nothing to
 * create into before then.
 *
 * Only toggles `creatingContact` — it does NOT touch the selection. The create form overlays the
 * detail pane via `Show` regardless of what's selected, so clearing it would be cosmetic; worse, it
 * would re-trigger ContactView's `on(selectedContactId)` effect (which runs AFTER this batched
 * handler) and reset `creatingContact` straight back to false. Leaving the selection alone keeps the
 * effect quiet, so the form actually opens.
 */
export function NewContactButton() {
  const canCreate = createMemo(() => writableBooks(addressBooks).length > 0);
  return (
    <Show when={canCreate()}>
      <button type="button" class="compose-button" onClick={() => setCreatingContact(true)}>
        <span aria-hidden="true">＋</span> New contact
      </button>
    </Show>
  );
}
