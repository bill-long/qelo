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
  /**
   * Fired when the transport reports a *genuine* auth failure — the credential is gone or
   * can't be refreshed (distinct from a transient drop, which just reconnects). The caller
   * should raise the re-auth gate, the same as a `JmapAuthError` on a regular request. Only
   * a transport that can tell auth failure apart from a drop calls this (the desktop Rust
   * channel); the raw-`EventSource` transport never does, so the browser path is unaffected.
   * After this fires the subscription is torn down locally (no further reconnects).
   */
  onAuthFailure?: () => void;
}

/**
 * Callbacks a transport drives, mirroring the EventSource events `subscribeToChanges`
 * cares about: `onOpen` once the stream is established, `onState` for each `state` event's
 * raw `data` payload, and `onError` when the stream drops or fails to open.
 */
export interface TransportCallbacks {
  onOpen: () => void;
  onState: (data: string) => void;
  onError: () => void;
  /**
   * The stream ended because of a genuine, unrecoverable auth failure (not a transient drop
   * to retry). A transport that can't tell the two apart (a raw `EventSource`) simply never
   * calls this and relies on `onError` + the next request's `JmapAuthError`.
   */
  onAuthError: () => void;
}

/** A live push transport. `close()` tears down its underlying stream. */
export interface PushTransport {
  close: () => void;
}

/**
 * Opens a push stream to `url` and drives `callbacks`. The byte transport is pluggable so
 * the reconnection logic here is shared: the browser/PWA build uses {@link eventSourceTransport}
 * (a raw `EventSource`), while the desktop build injects a transport that routes the stream
 * through the Rust backend — the only place the OAuth bearer token can be attached, since
 * EventSource can't set an `Authorization` header.
 */
export type OpenTransport = (url: string, callbacks: TransportCallbacks) => PushTransport;

/** Default transport: a raw `EventSource`. Used wherever push auth rides on the connection
 * itself (the browser/PWA dev build, where the Vite proxy injects credentials). */
function eventSourceTransport(url: string, callbacks: TransportCallbacks): PushTransport {
  const es = new EventSource(url);
  es.addEventListener("open", () => callbacks.onOpen());
  es.addEventListener("state", (event) => callbacks.onState((event as MessageEvent).data));
  es.addEventListener("error", () => callbacks.onError());
  return { close: () => es.close() };
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
 *
 * `openTransport` is the byte transport (default: a raw `EventSource`); the desktop build
 * injects one that routes the stream through Rust so the OAuth bearer token can be attached.
 * No-op (returns a noop) when the default EventSource transport is selected but EventSource
 * is absent (e.g. SSR); an injected transport is always honored.
 */
export function subscribeToChanges(
  session: Session,
  types: string[],
  handlers: PushHandlers,
  openTransport: OpenTransport = eventSourceTransport,
): () => void {
  if (openTransport === eventSourceTransport && typeof EventSource === "undefined") {
    return () => {};
  }

  const url = session.eventSourceUrl
    .replace("{types}", encodeURIComponent(types.join(",")))
    .replace("{closeafter}", "no")
    .replace("{ping}", "30");

  let source: PushTransport | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0; // consecutive failed/dropped connections, for backoff
  let attempted = false; // has the first connect been kicked off (vs. a reconnect)?
  let everOpened = false; // gate onReopen so it fires on re-opens, not the first open
  let closed = false; // unsubscribed: stop reconnecting and ignore late events
  let generation = 0; // bumped per connect(); identifies the latest attempt

  const connect = () => {
    if (closed) return;
    // The initial attempt is "connecting"; reconnects already announced "reconnecting"
    // when they were scheduled (on the drop), so don't flip back here.
    if (!attempted) handlers.onStatus?.("connecting");
    attempted = true;

    const myGen = ++generation;
    let transport: PushTransport | null = null;
    // Not superseded: still the latest connect() attempt and not unsubscribed. (A scheduled
    // reconnect bumps the generation only when it *fires*, so two callbacks from the same
    // transport — e.g. onError then onAuthError — both still see the current generation.)
    const current = () => !closed && myGen === generation;
    // The active *open* stream: current and not already torn down (a drop nulls `source`).
    // onOpen/onState/onError gate on this so a callback from a dropped stream is ignored.
    const active = () => current() && source === transport;

    transport = openTransport(url, {
      onOpen: () => {
        if (!active()) return;
        attempt = 0;
        handlers.onStatus?.("live");
        // Changes pushed while we were down were missed — resync to catch up. Skip the
        // very first open, since the caller did its own initial load.
        if (everOpened) handlers.onReopen?.();
        everOpened = true;
      },
      onState: (data) => {
        if (!active()) return;
        let change: StateChange;
        try {
          change = JSON.parse(data) as StateChange;
        } catch {
          return; // ignore malformed payloads (e.g. ping noise)
        }
        for (const [accountId, changed] of Object.entries(change.changed ?? {})) {
          handlers.onChange(accountId, changed);
        }
      },
      onError: () => {
        // The stream dropped or failed to open. EventSource would retry on its own, but
        // silently and at a fixed interval — take over so we can apply backoff and surface
        // "reconnecting". Close this transport (stops any native retry) and schedule ours.
        if (!active()) return;
        transport?.close();
        source = null;
        scheduleReconnect();
      },
      onAuthError: () => {
        // A genuine, unrecoverable auth failure (the bearer can't be refreshed). Reconnecting
        // would just 401 again, so stop the brain — close this transport, cancel any pending
        // reconnect — and hand off to the caller to raise the re-auth gate (which tears the
        // subscription down via the returned unsubscribe). Mirrors a request-path JmapAuthError.
        // Gate on `current()` not `active()`: this can arrive right after onError already
        // nulled `source` (the auth signal and the dropped-stream error race), and it must
        // still win — but a callback from a genuinely superseded transport is ignored.
        if (!current()) return;
        transport?.close();
        source = null;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        handlers.onAuthFailure?.();
      },
    });
    source = transport;
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
