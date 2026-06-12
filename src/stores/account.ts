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

const PROVIDER_ID = import.meta.env.VITE_JMAP_PROVIDER ?? "stalwart-dev";

/**
 * On desktop, authenticate with OAuth bearer tokens minted by the Rust backend; in the
 * browser dev build (no backend), fall back to the Basic-auth shim.
 */
function authProvider(): AuthProvider {
  if (isDesktop) {
    return bearerAuth(
      () => invoke<string>("get_access_token", { providerId: PROVIDER_ID }),
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
 * Sign out (desktop): clear the stored OAuth tokens and tear down the live connection —
 * stop push sync, drop the client/session, and return to a disconnected state — so no
 * further authenticated requests go out.
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
 * Route a caught error: if it's a {@link JmapAuthError} (a 401 whose token refresh
 * failed), tear down the live connection and flip back to the error/sign-in gate so the
 * user can re-authenticate, and return true. Non-auth errors are left for the caller to
 * handle locally (return false). This is the single place a mid-session auth failure —
 * from any store action — turns into a re-auth prompt.
 */
export function handleAuthFailure(err: unknown): boolean {
  if (!(err instanceof JmapAuthError)) return false;
  stopSync(); // the session is dead, so live updates are too — stop the EventSource
  client = null;
  setSession(null); // drop the stale session behind the now-dead client
  setConnectionError(err.message);
  setConnectionStatus("error");
  return true;
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
      // dev server's self-signed certificate. (No-op in production builds.) The
      // eventSourceUrl keeps its {types}/{closeafter}/{ping} template, so strip only
      // the origin rather than parsing it as a URL.
      s.apiUrl = new URL(s.apiUrl, window.location.origin).pathname;
      s.eventSourceUrl = s.eventSourceUrl.replace(/^https?:\/\/[^/]+/, "");
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
