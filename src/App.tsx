import "./App.css";
import { createSignal, type JSX, Match, onMount, Show, Switch } from "solid-js";
import { Shell } from "@/components/layout/Shell";
import {
  connect,
  connectionError,
  connectionStatus,
  handleAuthFailure,
  isDesktop,
  providerAuthKind,
  setConnectionError,
  setConnectionStatus,
  setSigningIn,
  signIn,
  signingIn,
  submitApiToken,
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
          <Show when={isDesktop && providerAuthKind() === "token"}>
            <ApiTokenForm />
          </Show>
          <div class="connect-actions">
            <Show when={isDesktop && providerAuthKind() === "oauth"}>
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
    if (handleAuthFailure(err)) return;
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

/**
 * Paste-a-token affordance for a token provider (e.g. Fastmail). Sits in the connection
 * gate in place of the OAuth "Sign in" button. The input is local component state; on submit
 * the token is handed to the Rust keychain (via {@link submitApiToken}) and then connect()
 * runs. Once the keychain holds the token (the source of truth), the local copy is cleared
 * so a long-lived credential doesn't linger in memory/the DOM if the gate stays visible.
 */
function ApiTokenForm() {
  const [token, setToken] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const canSubmit = () => !submitting() && token().trim() !== "";

  async function onSubmit(event: Event) {
    event.preventDefault();
    if (!canSubmit()) return;
    setSubmitting(true);
    try {
      await submitApiToken(token());
    } catch (err) {
      // The handoff itself failed (e.g. keychain write) — keep the typed token so the user
      // can retry without re-pasting, and surface the error in the gate.
      setConnectionError(err instanceof Error ? err.message : String(err));
      setConnectionStatus("error");
      return;
    } finally {
      setSubmitting(false);
    }
    // Token is now in the keychain; drop the in-memory/DOM copy before (re)connecting. A
    // transient connect() failure leaves the gate up, but Retry reuses the stored token.
    setToken("");
    // start() flips the gate to "connecting" and on to "connected"/"error" on its own.
    await start();
  }

  return (
    <form class="token-form" onSubmit={(event) => void onSubmit(event)}>
      <label class="token-label">
        <span>API token</span>
        <input
          type="password"
          autocomplete="off"
          spellcheck={false}
          value={token()}
          onInput={(event) => setToken(event.currentTarget.value)}
          placeholder="Paste your Fastmail API token"
        />
      </label>
      <button type="submit" disabled={!canSubmit()}>
        Connect
      </button>
    </form>
  );
}

function Centered(props: { children: JSX.Element }) {
  return <main class="centered">{props.children}</main>;
}

export default App;
