import { createSignal } from "solid-js";
import { basicAuth } from "@/jmap/auth";
import { JmapClient } from "@/jmap/client";
import type { Session } from "@/jmap/types";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export const [session, setSession] = createSignal<Session | null>(null);
export const [connectionStatus, setConnectionStatus] =
  createSignal<ConnectionStatus>("disconnected");
export const [connectionError, setConnectionError] = createSignal<string | null>(null);

// The JMAP client is plain (non-reactive) infrastructure; stores reach for it through
// jmap() to issue requests. Held module-level so there is a single connection.
let client: JmapClient | null = null;

/** The connected client. Throws if called before a successful connect(). */
export function jmap(): JmapClient {
  if (!client) throw new Error("JMAP client is not connected — call connect() first");
  return client;
}

/**
 * Establish the JMAP session. Uses the Basic-auth dev shim for now (replaced by the
 * OAuth bearer provider in Phase 1); credentials come from VITE_JMAP_* env vars.
 */
export async function connect(): Promise<void> {
  if (connectionStatus() === "connecting") return;
  setConnectionStatus("connecting");
  setConnectionError(null);
  try {
    const sessionUrl = import.meta.env.VITE_JMAP_SESSION_URL ?? "/.well-known/jmap";
    const email = import.meta.env.VITE_JMAP_EMAIL ?? "test@example.test";
    const password = import.meta.env.VITE_JMAP_PASSWORD ?? "";
    client = new JmapClient(sessionUrl, basicAuth(email, password));
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
