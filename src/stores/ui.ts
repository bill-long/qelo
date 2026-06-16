import { createSignal } from "solid-js";

/** Which top-level surface the shell shows. Calendar is reserved (its tab is disabled until
 * that milestone lands), but typed here so the switch's final shape is fixed now. */
export type PrimaryView = "mail" | "contacts" | "calendar";
export const [activeView, setActiveView] = createSignal<PrimaryView>("mail");

export const [selectedMailboxId, setSelectedMailboxId] = createSignal<string | null>(null);
export const [selectedThreadId, setSelectedThreadId] = createSignal<string | null>(null);
export const [selectedEmailId, setSelectedEmailId] = createSignal<string | null>(null);

// Contacts view selection. `selectedAddressBookId` null = the "All contacts" pseudo-book.
export const [selectedContactId, setSelectedContactId] = createSignal<string | null>(null);
export const [selectedAddressBookId, setSelectedAddressBookId] = createSignal<string | null>(null);

// Whether the create-contact form owns the detail pane (column 3). Set by the "+ New contact"
// affordance; cleared on save/cancel or when the selected contact changes (ContactView), so the
// form can't outlive its context. Distinct from the per-card `editing` mode, which is component-local.
export const [creatingContact, setCreatingContact] = createSignal(false);
