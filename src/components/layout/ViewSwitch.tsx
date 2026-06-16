import { createEffect, For } from "solid-js";
import { contactsAvailable } from "@/stores/contacts";
import { activeView, type PrimaryView, setActiveView } from "@/stores/ui";

interface ViewTab {
  view: PrimaryView;
  label: string;
  /** Why the tab is unavailable, or null when it's selectable. Disabled tabs stay visible. */
  unavailable: () => string | null;
}

const TABS: ViewTab[] = [
  { view: "mail", label: "Mail", unavailable: () => null },
  {
    view: "contacts",
    label: "Contacts",
    // Fails safe to disabled until a contacts-capable session is connected.
    unavailable: () => (contactsAvailable() ? null : "Contacts aren't available on this account"),
  },
  // Reserved: the Calendar surface is its own later milestone, so the tab is present (fixing the
  // switch's final shape) but disabled.
  { view: "calendar", label: "Calendar", unavailable: () => "Calendar is coming soon" },
];

/**
 * Top-level Mail / Contacts / Calendar switch in the sidebar header — it replaces the old static
 * "Qelo" brand label. Picks which primary surface the shell renders. A disabled tab (Calendar
 * always; Contacts until the capability is present) stays visible but is non-interactive, so the
 * final shape is set now and nothing dead-ends.
 */
export function ViewSwitch() {
  // Never leave the shell rendering an unavailable surface: if the active tab becomes unavailable
  // (signed out/in with the signal persisted, or an account-switch that drops contacts), fall back
  // to Mail. A reactive effect (not just onMount) so a mid-session availability change is honored.
  createEffect(() => {
    const active = TABS.find((t) => t.view === activeView());
    if (active && active.unavailable() !== null) setActiveView("mail");
  });

  return (
    <nav class="view-switch" aria-label="Views">
      <For each={TABS}>
        {(tab) => {
          const reason = () => tab.unavailable();
          const isActive = () => activeView() === tab.view;
          return (
            <button
              type="button"
              class="view-switch-tab"
              classList={{ "is-active": isActive(), "is-disabled": reason() !== null }}
              // aria-current marks the live view for AT. The tab stays focusable when unavailable
              // (aria-disabled, not the native `disabled` attribute) so keyboard/AT users can reach
              // it and hear WHY via the title; the click handler is the actual no-op guard.
              aria-current={isActive() ? "page" : undefined}
              aria-disabled={reason() !== null ? "true" : undefined}
              title={reason() ?? undefined}
              onClick={() => {
                if (reason() === null) setActiveView(tab.view);
              }}
            >
              {tab.label}
            </button>
          );
        }}
      </For>
    </nav>
  );
}
