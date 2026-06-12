import { createSignal } from "solid-js";

// Reactive OS color-scheme preference. Used to render the reading-pane iframe in the
// matching theme; updates live when the user flips their system theme.
const mql =
  typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;

const [prefersDark, setPrefersDark] = createSignal(mql?.matches ?? false);
mql?.addEventListener?.("change", (event) => setPrefersDark(event.matches));

export { prefersDark };
