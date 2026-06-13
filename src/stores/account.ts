import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { type AuthProvider, basicAuth, bearerAuth } from "@/jmap/auth";
import { JmapAuthError, JmapClient } from "@/jmap/client";
import type { Session } from "@/jmap/types";
import { stopSync } from "./sync";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

// Running inside the Tauri desktop shell (vs. the browser/PWA dev build)? Only the
// desktop shell has the Rust backend that performs the OAuth flow.
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const PROVIDER_ID = import.meta.env.VITE_JMAP_PROVIDER ?? "stalwart-dev";

/**
 * How the active provider authenticates, which decides the Connect-screen affordance:
 * an `oauth` provider gets a "Sign in" button (browser consent via {@link signIn}); a
 * `token` provider gets a paste field for a long-lived API token (via {@link submitApiToken}).
 *
 * This must stay in sync with the Rust provider registry (`provider()` in `src-tauri/src/auth.rs`):
 * a provider listed here as a token provider must be `ProviderKind::Token` there, and vice versa.
 */
export type AuthKind = "oauth" | "token";
const TOKEN_PROVIDERS = new Set(["fastmail-token"]);
export function providerAuthKind(providerId: string = PROVIDER_ID): AuthKind {
  return TOKEN_PROVIDERS.has(providerId) ? "token" : "oauth";
}

/**
 * On desktop, authenticate with OAuth bearer tokens minted by the Rust backend; in the
 * browser dev build (no backend), fall back to the Basic-auth shim.
 */
function authProvider(): AuthProvider {
  if (isDesktop) {
    return bearerAuth(
      () => invoke<string | null>("get_access_token", { providerId: PROVIDER_ID }),
      (staleToken) =>
        invoke<string | null>("refresh_access_token", {
          providerId: PROVIDER_ID,
          staleToken,
        }),
    );
  }
  // Browser/PWA build: the Basic-auth shim is a DEV-only stopgap — it bakes credentials
  // (VITE_JMAP_PASSWORD) into the bundle. A production web build has no auth backend yet
  // (OAuth needs the Rust shell), so fail closed rather than shipping embedded creds.
  if (!import.meta.env.DEV) {
    throw new Error(
      "No authentication method available in this build (sign-in requires the desktop app).",
    );
  }
  const email = import.meta.env.VITE_JMAP_EMAIL ?? "test@example.test";
  const password = import.meta.env.VITE_JMAP_PASSWORD ?? "";
  return basicAuth(email, password);
}

// Session URL returned by the desktop OAuth flow (the Rust command resolves it per
// provider). connect() prefers it so a provider whose session endpoint isn't the default
// path works without also setting VITE_JMAP_SESSION_URL. Null until a desktop sign-in.
let desktopSessionUrl: string | null = null;

/**
 * Run the interactive OAuth sign-in (desktop only). Resolves once tokens are stored,
 * capturing the provider's JMAP session URL (returned by the Rust command) for connect().
 */
export async function signIn(): Promise<void> {
  const url = await invoke<string>("oauth_login", { providerId: PROVIDER_ID });
  // In DEV, route the session URL through the same-origin Vite proxy (same reason connect()
  // rewrites apiUrl/eventSourceUrl) so it avoids the dev server's self-signed cert.
  desktopSessionUrl = import.meta.env.DEV ? new URL(url, window.location.origin).pathname : url;
}

/**
 * Token-provider sign-in (desktop only): hand a user-pasted long-lived API token to the
 * Rust backend, which stores it in the keychain and returns the provider's JMAP session URL.
 * The bearer-auth analogue of {@link signIn} — no browser consent, nothing to refresh. After
 * this resolves, connect() uses the captured session URL just like the OAuth path.
 */
export async function submitApiToken(token: string): Promise<void> {
  const url = await invoke<string>("store_api_token", { providerId: PROVIDER_ID, token });
  desktopSessionUrl = import.meta.env.DEV ? new URL(url, window.location.origin).pathname : url;
}

/**
 * Sign out (desktop): clear the provider's stored credentials (OAuth tokens or a pasted
 * API token — `logout` forgets whichever the keychain holds) and tear down the live
 * connection — stop push sync, drop the client/session, and return to a disconnected
 * state — so no further authenticated requests go out.
 */
export async function signOut(): Promise<void> {
  await invoke("logout", { providerId: PROVIDER_ID });
  stopSync();
  client = null;
  desktopSessionUrl = null;
  setSession(null);
  setConnectionError(null);
  setConnectionStatus("disconnected");
}

export const [session, setSession] = createSignal<Session | null>(null);
export const [connectionStatus, setConnectionStatus] =
  createSignal<ConnectionStatus>("disconnected");
export const [connectionError, setConnectionError] = createSignal<string | null>(null);
/** True while the interactive OAuth sign-in (browser consent) is in flight. */
export const [signingIn, setSigningIn] = createSignal(false);

// The JMAP client is plain (non-reactive) infrastructure; stores reach for it through
// jmap() to issue requests. Held module-level so there is a single connection.
let client: JmapClient | null = null;

/** The connected client. Throws if called before a successful connect(). */
export function jmap(): JmapClient {
  if (!client) throw new Error("JMAP client is not connected — call connect() first");
  return client;
}

/**
 * Test seam: install an already-connected client so the integration suite can drive the
 * store actions against the live Stalwart container. CLAUDE.md mandates a real JMAP server
 * (no mocking), and the singleton has no other injection point — `connect()` builds the
 * client from build-target-specific auth/env that don't apply under the test runner. App
 * code never calls this; it goes through `connect()`. Pass `null` to tear down between tests.
 */
export function adoptClient(injected: JmapClient | null): void {
  client = injected;
}

/**
 * Tear down the live connection and flip to the error/sign-in gate with `message` so the
 * user can re-authenticate: stop live updates, drop the client + stale session, and surface
 * the reason. The single place a mid-session auth failure — from a request or the push
 * stream — turns into a re-auth prompt.
 */
function enterReauthGate(message: string): void {
  stopSync(); // the session is dead, so live updates are too — stop the EventSource
  client = null;
  setSession(null); // drop the stale session behind the now-dead client
  setConnectionError(message);
  setConnectionStatus("error");
}

/**
 * Route a caught error: if it's a {@link JmapAuthError} (a 401 whose token refresh
 * failed), raise the re-auth gate and return true. Non-auth errors are left for the caller
 * to handle locally (return false).
 */
export function handleAuthFailure(err: unknown): boolean {
  if (!(err instanceof JmapAuthError)) return false;
  enterReauthGate(err.message);
  return true;
}

/**
 * Raise the re-auth gate from the push stream. The desktop push transport (Rust) reports a
 * genuine auth failure — the bearer is gone or still `401`s after a forced refresh — apart
 * from a transient drop. Previously that only looped reconnects until the next regular
 * request hit {@link JmapAuthError}; this surfaces it immediately, the same teardown a 401
 * on a request triggers.
 */
export function handlePushAuthFailure(): void {
  enterReauthGate("Push stream unauthorized; sign in again");
}

/**
 * Establish the JMAP session using OAuth on desktop or the Basic-auth shim in the
 * browser dev build (see authProvider). On desktop this throws if not yet signed in;
 * callers should offer signIn() in that case.
 */
export async function connect(): Promise<void> {
  if (connectionStatus() === "connecting") return;
  setConnectionStatus("connecting");
  setConnectionError(null);
  try {
    // Prefer an explicit env override, then the URL captured from the desktop OAuth
    // sign-in, then the default well-known path (browser dev build / not-yet-signed-in).
    const sessionUrl =
      import.meta.env.VITE_JMAP_SESSION_URL ?? desktopSessionUrl ?? "/.well-known/jmap";
    client = new JmapClient(sessionUrl, authProvider());
    const s = await client.connect();
    if (import.meta.env.DEV) {
      // Stalwart returns absolute URLs (https://localhost/...). Rewrite them to
      // same-origin paths so requests go through the Vite dev proxy and never hit the
      // dev server's self-signed certificate. (No-op in production builds.)
      s.apiUrl = new URL(s.apiUrl, window.location.origin).pathname;
      // The push stream is opened by EventSource in the browser (must be same-origin to use
      // the Vite proxy that injects credentials) but by the Rust backend on desktop, which
      // connects to the provider directly and trusts the loopback cert itself — so leave the
      // eventSourceUrl absolute for desktop. The {types}/{closeafter}/{ping} template is
      // preserved either way, so strip only the origin rather than parsing it as a URL.
      if (!isDesktop) {
        s.eventSourceUrl = s.eventSourceUrl.replace(/^https?:\/\/[^/]+/, "");
      }
    }
    setSession(s);
    setConnectionStatus("connected");
  } catch (err) {
    client = null;
    setSession(null); // don't leave a stale session behind a dead client
    setConnectionError(err instanceof Error ? err.message : String(err));
    setConnectionStatus("error");
  }
}
