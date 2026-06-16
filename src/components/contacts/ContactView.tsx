import { createMemo, For, type JSX, Show } from "solid-js";
import type { CardAddress, ContactCard } from "@/jmap/types";
import { contactDisplayName, sortedEmails } from "@/lib/contacts";
import { contactCards } from "@/stores/contacts";
import { selectedContactId } from "@/stores/ui";

/**
 * The contact detail (column 3, where ThreadView sits in mail view): a read-only, focused-complete
 * render of the selected JSContact card — name, emails, phones, postal addresses, organizations/
 * titles, online services, notes. No edit affordances (mutations are a later phase).
 */
export function ContactView() {
  const card = () => {
    const id = selectedContactId();
    return id ? contactCards[id] : undefined;
  };
  return (
    <div class="contact-view">
      <Show when={card()} fallback={<p class="contact-empty">Select a contact</p>}>
        {(c) => <ContactDetail card={c()} />}
      </Show>
    </div>
  );
}

// Space-join a structured address (full string if present, else its non-separator components).
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
  const dial = number.replace(/[^\d+().-]/g, "");
  return `tel:${dial}`;
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

function ContactDetail(props: { card: ContactCard }) {
  const card = () => props.card;
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
        <h1 class="contact-detail-name">{name()}</h1>
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
