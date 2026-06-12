// EventSource-based JMAP push subscription. See RFC 8620 §7.3.
//
// Pure transport: opens the event stream, reports StateChange notifications, and owns
// reconnection so a dropped stream is recovered (with backoff) and surfaced rather than
// failing silently. It does not know about stores — the caller wires changes/status to
// sync actions.

import type { Session } from "./types";

/** RFC 8620 StateChange: per-account map of typeName → new state string. */
export interface StateChange {
  changed: Record<string, Record<string, string>>;
}

/**
 * Live push-channel state, surfaced so the UI can show when live updates are degraded:
 * - `connecting`: opening the stream for the first time (no successful open yet).
 * - `live`: the stream is open and delivering changes.
 * - `reconnecting`: the stream dropped (or failed to open) and we're retrying with backoff.
 */
export type PushStatus = "connecting" | "live" | "reconnecting";

export interface PushHandlers {
  /** A StateChange arrived: `changed` maps changed type names to their new state. */
  onChange: (accountId: string, changed: Record<string, string>) => void;
  /** The push-channel state changed. */
  onStatus?: (status: PushStatus) => void;
  /**
   * Fired after a *re*-open (a successful connect that follows a drop), not the first
   * open. Changes pushed while the stream was down were missed, so the caller should do
   * a full resync to catch up.
   */
  onReopen?: () => void;
}

const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

/**
 * Exponential backoff delay (ms) for reconnect attempt `attempt` (0-based): the first
 * retry waits `baseMs`, each subsequent one doubles, capped at `maxMs`. Pure + tested.
 */
export function backoffDelay(
  attempt: number,
  baseMs = BASE_RECONNECT_MS,
  maxMs = MAX_RECONNECT_MS,
): number {
  // 2 ** large → Infinity; Math.min still clamps to maxMs, so this never overflows.
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

/**
 * Subscribe to server-pushed state changes. Opens the event stream and routes
 * notifications to `handlers.onChange`; reports channel state via `onStatus` and triggers
 * a catch-up resync via `onReopen` after a reconnect. Returns an unsubscribe function.
 * No-op (returns a noop) where EventSource is absent.
 */
export function subscribeToChanges(
  session: Session,
  types: string[],
  handlers: PushHandlers,
): () => void {
  if (typeof EventSource === "undefined") return () => {};

  const url = session.eventSourceUrl
    .replace("{types}", encodeURIComponent(types.join(",")))
    .replace("{closeafter}", "no")
    .replace("{ping}", "30");

  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0; // consecutive failed/dropped connections, for backoff
  let attempted = false; // has the first connect been kicked off (vs. a reconnect)?
  let everOpened = false; // gate onReopen so it fires on re-opens, not the first open
  let closed = false; // unsubscribed: stop reconnecting and ignore late events

  const connect = () => {
    if (closed) return;
    // The initial attempt is "connecting"; reconnects already announced "reconnecting"
    // when they were scheduled (on the drop), so don't flip back here.
    if (!attempted) handlers.onStatus?.("connecting");
    attempted = true;

    // EventSource cannot send an Authorization header, so push auth has to ride on the
    // connection itself. In the dev build the Vite proxy injects Basic auth for this
    // endpoint (see vite.config.ts). A production OAuth build still needs a real push-auth
    // story — a token in the connection, or routing SSE through the Rust backend — without
    // which this stream 401s; with this handler that surfaces as a reconnect loop (status
    // "reconnecting") rather than a silent failure. Tracked as a deferred follow-up.
    const es = new EventSource(url);
    source = es;

    es.addEventListener("open", () => {
      if (closed) return;
      attempt = 0;
      handlers.onStatus?.("live");
      // Changes pushed while we were down were missed — resync to catch up. Skip the
      // very first open, since the caller did its own initial load.
      if (everOpened) handlers.onReopen?.();
      everOpened = true;
    });

    es.addEventListener("state", (event) => {
      let change: StateChange;
      try {
        change = JSON.parse((event as MessageEvent).data) as StateChange;
      } catch {
        return; // ignore malformed payloads (e.g. ping noise)
      }
      for (const [accountId, changed] of Object.entries(change.changed ?? {})) {
        handlers.onChange(accountId, changed);
      }
    });

    es.addEventListener("error", () => {
      // The stream dropped or failed to open. The browser would retry on its own, but
      // silently and at a fixed interval — take over so we can apply backoff and surface
      // "reconnecting". Close this source (stops the native retry) and schedule our own.
      // Ignore a late error from a superseded stream (only the active source reconnects),
      // so a stale event can't spuriously kick off an extra reconnect.
      if (closed || source !== es) return;
      es.close();
      source = null;
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    handlers.onStatus?.("reconnecting");
    const delay = backoffDelay(attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    source?.close();
    source = null;
  };
}
