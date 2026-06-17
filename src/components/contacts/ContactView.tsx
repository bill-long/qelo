import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { ContactEditForm } from "@/components/contacts/ContactEditForm";
import type { CardAddress, ContactCard } from "@/jmap/types";
import {
  cardMayDelete,
  cardMayWrite,
  contactDisplayName,
  sortedEmails,
  writableBooks,
} from "@/lib/contacts";
import { addressBooks, contactCards, deleteContact } from "@/stores/contacts";
import { notify } from "@/stores/toasts";
import { creatingContact, selectedContactId, setCreatingContact } from "@/stores/ui";

/**
 * The contact detail (column 3, where ThreadView sits in mail view): a focused-complete render of
 * the selected JSContact card — name, emails, phones, postal addresses, organizations/titles, online
 * services, notes. An Edit affordance (gated on the card's address books granting `mayWrite`) swaps
 * in {@link ContactEditForm} in place; a read-only card shows no edit UI. The "+ New contact"
 * affordance puts the same form in create mode over this pane (regardless of selection).
 */
export function ContactView() {
  const [editing, setEditing] = createSignal(false);
  // A failed delete surfaces here, ABOVE the detail: deleteContact prunes the card optimistically, so
  // the ContactDetail that hosted the Delete button unmounts the instant delete is confirmed. On a
  // refusal the card is restored + re-selected (the detail re-mounts) and this error rides down to it
  // as a prop. Held on the always-mounted ContactView (not the unmounting detail) so it survives.
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  const card = () => {
    const id = selectedContactId();
    return id ? contactCards[id] : undefined;
  };
  // Leave edit AND create mode whenever the selected contact changes or clears, so a stale form can't
  // outlive its context (runs once on mount setting false, harmless). A successful create selects the
  // new card, which lands here and closes the create form onto the new contact's detail. Also clears a
  // stale delete error — a genuine selection change drops it; the null→same-id churn of a refused
  // delete's restore re-runs this before handleDelete sets the error, so the error still wins.
  createEffect(
    on(selectedContactId, () => {
      setEditing(false);
      setCreatingContact(false);
      setDeleteError(null);
    }),
  );

  async function handleDelete(id: string) {
    setDeleteError(null);
    const result = await deleteContact(id);
    if (result.ok) {
      notify("Contact deleted");
      return;
    }
    // The auth case raises the global re-auth gate — say nothing here. Otherwise the card has been
    // restored + re-selected, so report inline on the re-mounted detail.
    if (result.reason === "auth") return;
    setDeleteError(
      result.reason === "refused"
        ? "The server refused the deletion. The address book may be read-only, or the contact may have changed elsewhere."
        : "Couldn't delete the contact. Please try again.",
    );
  }
  // Clear the create form when the Contacts surface unmounts (the view switch swaps it out when
  // activeView leaves "contacts"), so a half-filled create can't silently resurface on return —
  // `creatingContact` is global UI state, unlike the component-local `editing`.
  onCleanup(() => setCreatingContact(false));
  const books = createMemo(() => writableBooks(addressBooks));

  return (
    <div class="contact-view">
      <Show
        when={creatingContact()}
        fallback={
          <Show when={card()} fallback={<p class="contact-empty">Select a contact</p>}>
            {(c) => (
              <Show
                when={editing()}
                fallback={
                  <ContactDetail
                    card={c()}
                    canEdit={cardMayWrite(c(), addressBooks)}
                    canDelete={cardMayDelete(c(), addressBooks)}
                    deleteError={deleteError()}
                    onEdit={() => setEditing(true)}
                    onDelete={(id) => void handleDelete(id)}
                  />
                }
              >
                <ContactEditForm mode="edit" card={c()} onClose={() => setEditing(false)} />
              </Show>
            )}
          </Show>
        }
      >
        <ContactEditForm mode="create" books={books()} onClose={() => setCreatingContact(false)} />
      </Show>
    </div>
  );
}

// Render a structured address: the `full` string if present, else its non-separator components
// comma-joined (street/city/region read naturally on one line).
function formatAddress(addr: CardAddress): string {
  if (addr.full?.trim()) return addr.full.trim();
  return (addr.components ?? [])
    .filter((p) => p.kind !== "separator" && p.value.trim() !== "")
    .map((p) => p.value.trim())
    .join(", ");
}

// The first context key (work/private/…) as a short label, or null.
function contextLabel(contexts: Record<string, true> | undefined): string | null {
  const keys = Object.keys(contexts ?? {});
  return keys[0] ?? null;
}

// Collect the trimmed, non-empty string field `pick` from each value of an id-keyed JSContact map
// (the shape of organizations/titles/notes/nicknames). Centralizes the repeated values→map→filter.
function trimmedFrom<T>(
  map: Record<string, T> | undefined,
  pick: (v: T) => string | undefined,
): string[] {
  return Object.values(map ?? {})
    .map((v) => pick(v)?.trim())
    .filter((s): s is string => Boolean(s));
}

// Build a `tel:` href without percent-encoding: encodeURIComponent would turn the leading `+` into
// `%2B` (and visual separators into %xx), which many diallers won't parse. Instead reduce the number
// to the characters a tel URI permits (RFC 3966: digits, a leading `+`, and visual separators), so
// `+1-555-0100` stays dialable. Untrusted data, so anything outside that set is dropped.
function telHref(number: string): string {
  const cleaned = number.replace(/[^\d+().-]/g, "");
  // RFC 3966 allows `+` only as the leading char (the global-number prefix); keep a leading one,
  // strip any others so a mid-string `+` (e.g. "1+23") can't produce a non-conformant tel: URI.
  const prefix = cleaned.startsWith("+") ? "+" : "";
  return `tel:${prefix}${cleaned.replaceAll("+", "")}`;
}

// An online-service `uri` is untrusted card data, so only surface it as a clickable link when it's
// an http(s) URL — a `javascript:`/`data:` scheme would otherwise execute on click. Anything else
// (or an unparseable value) renders as plain text. mailto: (encodeURIComponent) and tel: (telHref)
// are built locally from a fixed scheme + sanitized value, so they don't need this.
function httpHref(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function ContactDetail(props: {
  card: ContactCard;
  canEdit: boolean;
  canDelete: boolean;
  deleteError: string | null;
  onEdit: () => void;
  onDelete: (id: string) => void;
}) {
  const card = () => props.card;
  // The inline two-step delete confirm (Bill's choice): the Delete button swaps the header into a
  // "Delete X? [Delete] [Cancel]" row. Component-local — confirming, not the deletion itself; the
  // confirm "Delete" hands off to onDelete (deleteContact), whose optimistic prune unmounts this
  // detail. Reset when the displayed card changes so a half-armed confirm can't carry to the next
  // contact (Show doesn't re-mount this between two truthy cards, so reset explicitly).
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  createEffect(
    on(
      () => props.card.id,
      () => setConfirmingDelete(false),
    ),
  );
  const name = createMemo(() => contactDisplayName(card()));
  const emails = createMemo(() => sortedEmails(card()));
  const phones = createMemo(() => Object.values(card().phones ?? {}).filter((p) => p?.number));
  const addresses = createMemo(() =>
    Object.values(card().addresses ?? {})
      .map((a) => ({ label: contextLabel(a?.contexts), text: a ? formatAddress(a) : "" }))
      .filter((a) => a.text !== ""),
  );
  const organizations = createMemo(() => trimmedFrom(card().organizations, (o) => o?.name));
  const titles = createMemo(() => trimmedFrom(card().titles, (t) => t?.name));
  const notes = createMemo(() => trimmedFrom(card().notes, (n) => n?.note));
  const nicknames = createMemo(() => trimmedFrom(card().nicknames, (n) => n?.name));
  const services = createMemo(() =>
    Object.values(card().onlineServices ?? {}).filter((s) => s?.uri || s?.user),
  );

  return (
    <article class="contact-detail">
      <header class="contact-detail-head">
        <div class="contact-detail-headline">
          <h1 class="contact-detail-name">{name()}</h1>
          <Show
            when={confirmingDelete()}
            fallback={
              <div class="contact-detail-actions">
                <Show when={props.canEdit}>
                  <button type="button" class="contact-edit-button" onClick={() => props.onEdit()}>
                    Edit
                  </button>
                </Show>
                <Show when={props.canDelete}>
                  <button
                    type="button"
                    class="contact-delete-button"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete
                  </button>
                </Show>
              </div>
            }
          >
            <fieldset class="contact-delete-confirm" aria-label="Confirm delete contact">
              <span class="contact-delete-prompt">Delete “{name()}”?</span>
              <button
                type="button"
                class="contact-delete-button"
                onClick={() => props.onDelete(props.card.id)}
              >
                Delete
              </button>
              <button
                type="button"
                class="contact-delete-cancel"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </fieldset>
          </Show>
        </div>
        <Show when={props.deleteError}>
          {(message) => (
            <p class="contact-edit-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={nicknames().length > 0}>
          <p class="contact-detail-nicknames">“{nicknames().join("”, “")}”</p>
        </Show>
        <Show when={organizations().length > 0 || titles().length > 0}>
          <p class="contact-detail-org">{[...titles(), ...organizations()].join(" · ")}</p>
        </Show>
      </header>

      <DetailSection label="Email" when={emails().length > 0}>
        <For each={emails()}>
          {(email) => (
            <DetailRow context={contextLabel(email.contexts)}>
              <a href={`mailto:${encodeURIComponent(email.address)}`}>{email.address}</a>
            </DetailRow>
          )}
        </For>
      </DetailSection>

      <DetailSection label="Phone" when={phones().length > 0}>
        <For each={phones()}>
          {(phone) => (
            <DetailRow context={contextLabel(phone.contexts)}>
              <a href={telHref(phone.number)}>{phone.number}</a>
            </DetailRow>
          )}
        </For>
      </DetailSection>

      <DetailSection label="Address" when={addresses().length > 0}>
        <For each={addresses()}>
          {(addr) => <DetailRow context={addr.label}>{addr.text}</DetailRow>}
        </For>
      </DetailSection>

      <DetailSection label="Online" when={services().length > 0}>
        <For each={services()}>
          {(svc) => {
            const href = httpHref(svc.uri);
            const text = svc.user ?? svc.uri ?? "";
            return (
              <DetailRow context={svc.service ?? contextLabel(svc.contexts)}>
                <Show when={href} fallback={text}>
                  {(safe) => (
                    <a href={safe()} target="_blank" rel="noopener noreferrer">
                      {text}
                    </a>
                  )}
                </Show>
              </DetailRow>
            );
          }}
        </For>
      </DetailSection>

      <DetailSection label="Notes" when={notes().length > 0}>
        <For each={notes()}>{(note) => <p class="contact-note">{note}</p>}</For>
      </DetailSection>
    </article>
  );
}

function DetailSection(props: { label: string; when: boolean; children: JSX.Element }) {
  return (
    <Show when={props.when}>
      <section class="contact-detail-section">
        <h2 class="contact-detail-label">{props.label}</h2>
        {props.children}
      </section>
    </Show>
  );
}

function DetailRow(props: { context: string | null | undefined; children: JSX.Element }) {
  return (
    <div class="contact-detail-row">
      <div class="contact-detail-value">{props.children}</div>
      <Show when={props.context}>
        {(label) => <span class="contact-detail-context">{label()}</span>}
      </Show>
    </div>
  );
}
