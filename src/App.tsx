import "./App.css";
import { type JSX, Match, onMount, Show, Switch } from "solid-js";
import { Shell } from "@/components/layout/Shell";
import {
  connect,
  connectionError,
  connectionStatus,
  isDesktop,
  setConnectionError,
  setConnectionStatus,
  setSigningIn,
  signIn,
  signingIn,
} from "@/stores/account";
import { loadMailboxes } from "@/stores/mailboxes";
import { startSync } from "@/stores/sync";

function App() {
  onMount(() => {
    void start();
  });

  return (
    <Switch fallback={<Centered>Connecting…</Centered>}>
      <Match when={signingIn()}>
        <Centered>Signing in… complete the sign-in in your browser.</Centered>
      </Match>
      <Match when={connectionStatus() === "connected"}>
        <Shell />
      </Match>
      <Match when={connectionStatus() === "error"}>
        <Centered>
          <p>Couldn't connect to your mail.</p>
          <pre class="connect-error">{connectionError()}</pre>
          <div class="connect-actions">
            <Show when={isDesktop}>
              <button type="button" onClick={() => void signInThenStart()}>
                Sign in
              </button>
            </Show>
            <button type="button" onClick={() => void start()}>
              Retry
            </button>
          </div>
        </Centered>
      </Match>
    </Switch>
  );
}

/** Connect, then load the folder list once the session is established. */
async function start() {
  await connect();
  if (connectionStatus() !== "connected") return;
  // The connection gate only reflects connect(); surface an initial-load failure the
  // same way (error view + Retry) instead of leaving an empty folder pane.
  try {
    await loadMailboxes();
    startSync(); // live updates via EventSource once the initial data is in
  } catch (err) {
    setConnectionError(err instanceof Error ? err.message : String(err));
    setConnectionStatus("error");
  }
}

/** Desktop: run the OAuth sign-in, then connect. */
async function signInThenStart() {
  setSigningIn(true);
  try {
    await signIn();
  } catch (err) {
    setConnectionError(err instanceof Error ? err.message : String(err));
    setConnectionStatus("error");
    return;
  } finally {
    setSigningIn(false);
  }
  await start();
}

function Centered(props: { children: JSX.Element }) {
  return <main class="centered">{props.children}</main>;
}

export default App;
