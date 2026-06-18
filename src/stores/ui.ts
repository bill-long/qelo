import { createSignal } from "solid-js";
import { type CalendarViewMode, todayAnchor } from "@/lib/calendar";

/** Which top-level surface the shell shows. Mail, Contacts, and Calendar are all live; the tab for
 * each is capability-gated in ViewSwitch. */
export type PrimaryView = "mail" | "contacts" | "calendar";
export const [activeView, setActiveView] = createSignal<PrimaryView>("mail");

export const [selectedMailboxId, setSelectedMailboxId] = createSignal<string | null>(null);
export const [selectedThreadId, setSelectedThreadId] = createSignal<string | null>(null);
export const [selectedEmailId, setSelectedEmailId] = createSignal<string | null>(null);

// Contacts view selection. `selectedAddressBookId` null = the "All contacts" pseudo-book.
export const [selectedContactId, setSelectedContactId] = createSignal<string | null>(null);
export const [selectedAddressBookId, setSelectedAddressBookId] = createSignal<string | null>(null);

// Calendar view selection. `selectedCalendarId` null = the "All calendars" pseudo-calendar.
export const [selectedEventId, setSelectedEventId] = createSignal<string | null>(null);
export const [selectedCalendarId, setSelectedCalendarId] = createSignal<string | null>(null);

// Calendar view navigation (Calendar Views milestone): which view the surface renders and the
// focused date that drives the visible window. `calendarAnchor` is always a LOCAL-midnight Date
// (see todayAnchor); changing either re-queries the window (the Calendar surface watches them).
// Default mode is "month" — the conventional calendar landing (the month grid is live as of the
// month-grid branch). The store derives the query window via lib/calendar `visibleRange`.
// These deliberately PERSIST across a calendar↔mail surface switch (no onCleanup reset, unlike the
// transient `creatingEvent` below): they're a navigational position, so returning to the calendar
// lands on the same view + date — standard calendar behavior. resetStores() resets them for tests.
export const [calendarViewMode, setCalendarViewMode] = createSignal<CalendarViewMode>("month");
export const [calendarAnchor, setCalendarAnchor] = createSignal<Date>(todayAnchor());

// Whether the create-contact form owns the detail pane (column 3). Set by the "+ New contact"
// affordance; cleared on save/cancel or when the selected contact changes (ContactView), so the
// form can't outlive its context. Distinct from the per-card `editing` mode, which is component-local.
export const [creatingContact, setCreatingContact] = createSignal(false);

// Whether the create-event form owns the detail pane (column 3). Set by the "+ New event" affordance;
// cleared on save/cancel, when the selected event changes, or when the Calendar surface unmounts
// (EventView), so the form can't outlive its context. Distinct from EventView's per-event `editing`
// mode, which is component-local. Mirrors `creatingContact`.
export const [creatingEvent, setCreatingEvent] = createSignal(false);
