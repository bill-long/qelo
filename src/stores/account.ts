import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import { type AuthHeaderProvider, basicAuth, bearerAuth } from "@/jmap/auth";
import { JmapClient } from "@/jmap/client";
import type { Session } from "@/jmap/types";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

// Running inside the Tauri desktop shell (vs. the browser/PWA dev build)? Only the
// desktop shell has the Rust backend that performs the OAuth flow.
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const PROVIDER_ID = import.meta.env.VITE_JMAP_PROVIDER ?? "stalwart-dev";

/**
 * On desktop, authenticate with OAuth bearer tokens minted by the Rust backend; in the
 * browser dev build (no backend), fall back to the Basic-auth shim.
 */
function authProvider(): AuthHeaderProvider {
  if (isDesktop) {
    return bearerAuth(() => invoke<string>("get_access_token", { providerId: PROVIDER_ID }));
  }
  const email = import.meta.env.VITE_JMAP_EMAIL ?? "test@example.test";
  const password = import.meta.env.VITE_JMAP_PASSWORD ?? "";
  return basicAuth(email, password);
}

/** Run the interactive OAuth sign-in (desktop only). Resolves once tokens are stored. */
export async function signIn(): Promise<void> {
  await invoke("oauth_login", { providerId: PROVIDER_ID });
}

/** Clear stored OAuth tokens (desktop only). */
export async function signOut(): Promise<void> {
  await invoke("logout", { providerId: PROVIDER_ID });
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
 * Establish the JMAP session using OAuth on desktop or the Basic-auth shim in the
 * browser dev build (see authProvider). On desktop this throws if not yet signed in;
 * callers should offer signIn() in that case.
 */
export async function connect(): Promise<void> {
  if (connectionStatus() === "connecting") return;
  setConnectionStatus("connecting");
  setConnectionError(null);
  try {
    const sessionUrl = import.meta.env.VITE_JMAP_SESSION_URL ?? "/.well-known/jmap";
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
