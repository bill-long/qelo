import { createSignal } from "solid-js";

// Reactive OS color-scheme preference. Used to render the reading-pane iframe in the
// matching theme; updates live when the user flips their system theme.
const mql =
  typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;

const [prefersDark, setPrefersDark] = createSignal(mql?.matches ?? false);

const onSchemeChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
mql?.addEventListener?.("change", onSchemeChange);

// HMR: remove the listener when this module is replaced so dev reloads don't stack
// duplicate handlers. No-op in production, where import.meta.hot is undefined.
import.meta.hot?.dispose(() => mql?.removeEventListener?.("change", onSchemeChange));

export { prefersDark };
