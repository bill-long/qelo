import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import type { ContactCard } from "@/jmap/types";
import { cardToEditable, type EditableContact } from "@/lib/contacts";
import { saveContact } from "@/stores/contacts";
import { notify } from "@/stores/toasts";

// The single-value sections of EditableContact (everything but nameFull + onlineServices), each an
// array of {key, value} rows the generic ListField edits.
type SingleKey =
  | "nicknames"
  | "emails"
  | "phones"
  | "addresses"
  | "organizations"
  | "titles"
  | "notes";

/**
 * Edit an existing contact in place (column 3, replacing the read-only ContactDetail). A working
 * copy of the card (seeded by `cardToEditable`) is edited locally; Save builds the minimal patch and
 * dispatches `saveContact`, which owns the JMAP round trip + optimistic update. Covers every field
 * the detail view renders: name, nicknames, emails, phones, postal addresses (one-line), orgs,
 * titles, online services, notes. Errors surface inline (toasts are success-only); a successful save
 * confirms with a toast and closes back to the detail.
 */
export function ContactEditForm(props: { card: ContactCard; onClose: () => void }) {
  // Freeze a plain-object snapshot of the card at open. It seeds the working copy AND is the baseline
  // saveContact diffs against, so the patch is exactly the user's delta (and a concurrent background
  // sync that mutates the live store card can't shift the baseline out from under the edit). A
  // one-time read: re-deriving mid-edit would clobber the user's typing, and a selection change
  // unmounts the form (ContactView exits edit mode).
  // eslint-disable-next-line solid/reactivity
  const baseline = structuredClone(unwrap(props.card)) as ContactCard;
  const [form, setForm] = createStore<EditableContact>(cardToEditable(baseline));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let nameInput: HTMLInputElement | undefined;
  onMount(() => nameInput?.focus());

  function setValue(section: SingleKey, index: number, value: string) {
    setForm(section, index, "value", value);
  }
  function addRow(section: SingleKey) {
    setForm(section, (rows) => [...rows, { key: null, value: "" }]);
  }
  function removeRow(section: SingleKey, index: number) {
    setForm(section, (rows) => rows.filter((_, i) => i !== index));
  }

  function setService(index: number, field: "service" | "user" | "uri", value: string) {
    setForm("onlineServices", index, field, value);
  }
  function addService() {
    setForm("onlineServices", (rows) => [...rows, { key: null, service: "", user: "", uri: "" }]);
  }
  function removeService(index: number) {
    setForm("onlineServices", (rows) => rows.filter((_, i) => i !== index));
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    // unwrap the store proxy to a plain EditableContact for the pure transform in the store action.
    const result = await saveContact(baseline.id, baseline, unwrap(form));
    setBusy(false);
    if (result.ok) {
      notify("Contact saved");
      props.onClose();
      return;
    }
    // The auth case raises the global re-auth gate — keep the form as-is and say nothing here.
    if (result.reason === "auth") return;
    setError(
      result.reason === "refused"
        ? "The server refused the change. It may be read-only or have changed elsewhere."
        : "Couldn’t save the contact. Please try again.",
    );
  }

  return (
    <form
      class="contact-edit"
      aria-labelledby="contact-edit-title"
      onSubmit={(e) => void handleSubmit(e)}
    >
      <header class="contact-edit-head">
        <h1 id="contact-edit-title" class="contact-detail-name">
          Edit contact
        </h1>
      </header>

      <label class="contact-edit-field">
        <span class="contact-edit-label">Name</span>
        <input
          ref={nameInput}
          type="text"
          class="contact-edit-input"
          value={form.nameFull}
          onInput={(e) => setForm("nameFull", e.currentTarget.value)}
        />
      </label>

      <ListField
        legend="Nicknames"
        addLabel="Add nickname"
        rows={form.nicknames}
        onChange={(i, v) => setValue("nicknames", i, v)}
        onAdd={() => addRow("nicknames")}
        onRemove={(i) => removeRow("nicknames", i)}
      />
      <ListField
        legend="Email"
        addLabel="Add email"
        type="email"
        rows={form.emails}
        onChange={(i, v) => setValue("emails", i, v)}
        onAdd={() => addRow("emails")}
        onRemove={(i) => removeRow("emails", i)}
      />
      <ListField
        legend="Phone"
        addLabel="Add phone"
        type="tel"
        rows={form.phones}
        onChange={(i, v) => setValue("phones", i, v)}
        onAdd={() => addRow("phones")}
        onRemove={(i) => removeRow("phones", i)}
      />
      <ListField
        legend="Address"
        addLabel="Add address"
        multiline
        rows={form.addresses}
        onChange={(i, v) => setValue("addresses", i, v)}
        onAdd={() => addRow("addresses")}
        onRemove={(i) => removeRow("addresses", i)}
      />
      <ListField
        legend="Organization"
        addLabel="Add organization"
        rows={form.organizations}
        onChange={(i, v) => setValue("organizations", i, v)}
        onAdd={() => addRow("organizations")}
        onRemove={(i) => removeRow("organizations", i)}
      />
      <ListField
        legend="Title"
        addLabel="Add title"
        rows={form.titles}
        onChange={(i, v) => setValue("titles", i, v)}
        onAdd={() => addRow("titles")}
        onRemove={(i) => removeRow("titles", i)}
      />

      <fieldset class="contact-edit-section">
        <legend class="contact-edit-legend">Online</legend>
        <For each={form.onlineServices}>
          {(row, i) => (
            <div class="contact-edit-service">
              <input
                type="text"
                class="contact-edit-input"
                aria-label={`Online service ${i() + 1} label`}
                placeholder="Service"
                value={row.service}
                onInput={(e) => setService(i(), "service", e.currentTarget.value)}
              />
              <input
                type="text"
                class="contact-edit-input"
                aria-label={`Online service ${i() + 1} user`}
                placeholder="User"
                value={row.user}
                onInput={(e) => setService(i(), "user", e.currentTarget.value)}
              />
              <input
                type="url"
                class="contact-edit-input"
                aria-label={`Online service ${i() + 1} URL`}
                placeholder="URL"
                value={row.uri}
                onInput={(e) => setService(i(), "uri", e.currentTarget.value)}
              />
              <button
                type="button"
                class="contact-edit-remove"
                aria-label={`Remove online service ${i() + 1}`}
                onClick={() => removeService(i())}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          )}
        </For>
        <button type="button" class="contact-edit-add" onClick={addService}>
          + Add online service
        </button>
      </fieldset>

      <ListField
        legend="Notes"
        addLabel="Add note"
        multiline
        rows={form.notes}
        onChange={(i, v) => setValue("notes", i, v)}
        onAdd={() => addRow("notes")}
        onRemove={(i) => removeRow("notes", i)}
      />

      <Show when={error()}>
        {(message) => (
          <p class="contact-edit-error" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <footer class="contact-edit-actions">
        <button type="submit" class="contact-edit-save" disabled={busy()}>
          {busy() ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          class="contact-edit-cancel"
          disabled={busy()}
          onClick={() => props.onClose()}
        >
          Cancel
        </button>
      </footer>
    </form>
  );
}

// A repeated single-value field: one input (or textarea) per row plus add/remove. Each input carries
// an aria-label since the rows share one <legend> rather than per-row visible labels. `For` keys by
// the row object's identity, which a value edit preserves (fine-grained store update), so editing a
// row doesn't recreate the input and steal focus.
function ListField(props: {
  legend: string;
  addLabel: string;
  rows: Array<{ value: string }>;
  type?: string;
  multiline?: boolean;
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}): JSX.Element {
  return (
    <fieldset class="contact-edit-section">
      <legend class="contact-edit-legend">{props.legend}</legend>
      <For each={props.rows}>
        {(row, i) => (
          <div class="contact-edit-row">
            <Show
              when={props.multiline}
              fallback={
                <input
                  type={props.type ?? "text"}
                  class="contact-edit-input"
                  aria-label={`${props.legend} ${i() + 1}`}
                  value={row.value}
                  onInput={(e) => props.onChange(i(), e.currentTarget.value)}
                />
              }
            >
              <textarea
                class="contact-edit-input"
                aria-label={`${props.legend} ${i() + 1}`}
                rows="2"
                value={row.value}
                onInput={(e) => props.onChange(i(), e.currentTarget.value)}
              />
            </Show>
            <button
              type="button"
              class="contact-edit-remove"
              aria-label={`Remove ${props.legend} ${i() + 1}`}
              onClick={() => props.onRemove(i())}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        )}
      </For>
      <button type="button" class="contact-edit-add" onClick={() => props.onAdd()}>
        + {props.addLabel}
      </button>
    </fieldset>
  );
}
