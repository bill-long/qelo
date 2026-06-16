import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import type { AddressBook, ContactCard } from "@/jmap/types";
import {
  cardToEditable,
  defaultWritableBookId,
  type EditableContact,
  editableHasContent,
  emptyEditableContact,
} from "@/lib/contacts";
import { createContact, saveContact } from "@/stores/contacts";
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

/** Edit an existing card, or create a fresh one in a chosen writable book. The `books` (create mode)
 * are the writable address books — guaranteed non-empty by the affordance's gate. */
export type ContactEditFormProps = { onClose: () => void } & (
  | { mode: "edit"; card: ContactCard }
  | { mode: "create"; books: AddressBook[] }
);

/**
 * Edit an existing contact, or create a new one, in place (column 3, replacing the read-only
 * ContactDetail). A working copy — seeded from the card (`cardToEditable`) when editing, blank when
 * creating — is edited locally; Save dispatches `saveContact` (a minimal patch) or `createContact`
 * (a new card in the chosen book), which own the JMAP round trip + store update. Covers every field
 * the detail view renders: name, nicknames, emails, phones, postal addresses (one-line), orgs,
 * titles, online services, notes. Errors surface inline (toasts are success-only); a successful
 * save/create confirms with a toast and closes back to the detail.
 */
export function ContactEditForm(props: ContactEditFormProps) {
  // Freeze a plain-object snapshot of the card at open (edit mode only). It seeds the working copy
  // AND is the baseline saveContact diffs against, so the patch is exactly the user's delta (and a
  // concurrent background sync that mutates the live store card can't shift the baseline out from
  // under the edit). A one-time read: re-deriving mid-edit would clobber the user's typing, and a
  // selection change unmounts the form (ContactView exits edit/create mode).
  // eslint-disable-next-line solid/reactivity
  const editCard = props.mode === "edit" ? props.card : null;
  const baseline = editCard ? (structuredClone(unwrap(editCard)) as ContactCard) : null;
  const [form, setForm] = createStore<EditableContact>(
    baseline ? cardToEditable(baseline) : emptyEditableContact(),
  );
  // Create mode: which writable book the new card lands in. Defaults to the server-default writable
  // book; a `<select>` lets the user pick only when there's more than one. (Static for the form's
  // life — the books list doesn't change under an open form; reading props.books once is fine.)
  // eslint-disable-next-line solid/reactivity
  const createBooks = props.mode === "create" ? props.books : [];
  const [bookId, setBookId] = createSignal<string | null>(defaultWritableBookId(createBooks));
  // Create mode gates Save on the form holding at least one savable field (the edit path has its own
  // empty-patch no-op, so it's always submittable). Reactive over the store so it tracks typing.
  const canSubmit = createMemo(() => props.mode === "edit" || editableHasContent(form));
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
    if (busy() || !canSubmit()) return;
    setBusy(true);
    setError(null);
    // unwrap the store proxy to a plain EditableContact for the pure transform in the store action.
    const edits = unwrap(form);
    if (baseline) {
      const result = await saveContact(baseline.id, baseline, edits);
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
      return;
    }

    const book = bookId();
    if (!book) {
      setBusy(false);
      setError("No writable address book to save into.");
      return;
    }
    const result = await createContact(edits, { [book]: true });
    setBusy(false);
    if (result.ok) {
      notify("Contact created");
      props.onClose(); // createContact already selected the new card
      return;
    }
    if (result.reason === "auth") return;
    setError(
      result.reason === "refused"
        ? "The server refused the new contact. The address book may be read-only."
        : "Couldn’t create the contact. Please try again.",
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
          {props.mode === "create" ? "New contact" : "Edit contact"}
        </h1>
      </header>

      {/* Book picker — create mode with a choice. One writable book needs no picker (it's implicit);
          zero is impossible here (the affordance is gated on a writable book existing). */}
      <Show when={props.mode === "create" && createBooks.length > 1}>
        <label class="contact-edit-field">
          <span class="contact-edit-label">Address book</span>
          <select
            class="contact-edit-input"
            value={bookId() ?? ""}
            onChange={(e) => setBookId(e.currentTarget.value)}
          >
            <For each={createBooks}>{(book) => <option value={book.id}>{book.name}</option>}</For>
          </select>
        </label>
      </Show>

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
        <button type="submit" class="contact-edit-save" disabled={busy() || !canSubmit()}>
          {busy()
            ? props.mode === "create"
              ? "Creating…"
              : "Saving…"
            : props.mode === "create"
              ? "Create"
              : "Save"}
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
