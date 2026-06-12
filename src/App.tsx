import "./App.css";
import { type JSX, Match, onMount, Switch } from "solid-js";
import { Shell } from "@/components/layout/Shell";
import {
  connect,
  connectionError,
  connectionStatus,
  setConnectionError,
  setConnectionStatus,
} from "@/stores/account";
import { loadMailboxes } from "@/stores/mailboxes";

function App() {
  onMount(() => {
    void start();
  });

  return (
    <Switch fallback={<Centered>Connecting…</Centered>}>
      <Match when={connectionStatus() === "connected"}>
        <Shell />
      </Match>
      <Match when={connectionStatus() === "error"}>
        <Centered>
          <p>Couldn't reach the mail server.</p>
          <pre class="connect-error">{connectionError()}</pre>
          <button type="button" onClick={() => void start()}>
            Retry
          </button>
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
  } catch (err) {
    setConnectionError(err instanceof Error ? err.message : String(err));
    setConnectionStatus("error");
  }
}

function Centered(props: { children: JSX.Element }) {
  return <main class="centered">{props.children}</main>;
}

export default App;
