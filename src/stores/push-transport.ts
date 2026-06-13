// Desktop push transport: routes the JMAP EventSource stream through the Rust backend.
//
// EventSource can't set an `Authorization` header, so under OAuth the desktop build opens
// the push stream in Rust (which attaches the bearer token) and streams events back over a
// Tauri channel. This adapts that channel to the `OpenTransport` seam in jmap/push.ts, which
// keeps owning reconnection/backoff — this module is just the byte transport. Living in the
// store layer (not jmap/) keeps the protocol layer free of Tauri coupling.

import { Channel, invoke } from "@tauri-apps/api/core";
import type { OpenTransport } from "@/jmap/push";
import { PROVIDER_ID } from "./account";

/** Events forwarded by the Rust `open_push_stream` command (see src-tauri/src/auth.rs). */
type PushEvent = { type: "open" } | { type: "state"; data: string };

/**
 * Open the push stream via the Rust backend. The `open_push_stream` command stays pending
 * while the stream is live and settles (resolve or reject) when it drops — either way the
 * stream is no longer delivering, so we surface that to `onError` to drive a reconnect,
 * unless we closed it deliberately.
 */
export const tauriChannelTransport: OpenTransport = (url, callbacks) => {
  const streamId = crypto.randomUUID();
  const channel = new Channel<PushEvent>();
  let closed = false;

  channel.onmessage = (event) => {
    if (closed) return;
    if (event.type === "open") callbacks.onOpen();
    else if (event.type === "state") callbacks.onState(event.data);
  };

  void invoke("open_push_stream", { providerId: PROVIDER_ID, streamId, url, onEvent: channel })
    .catch((err) => {
      // A dropped stream rejects with a diagnostic (e.g. "push stream unauthorized; sign in
      // again"). Recovery is the same — push.ts reconnects on onError, and a genuine auth
      // failure also surfaces via the next regular JMAP request's JmapAuthError gate — but
      // log the reason so a persistent push failure isn't invisible. Skip if we closed it.
      if (!closed) console.warn("Push stream ended:", err);
    })
    .finally(() => {
      // The command settled, so the stream ended. If we didn't close it deliberately, treat
      // it as a drop so the reconnection logic in push.ts schedules a retry.
      if (!closed) callbacks.onError();
    });

  return {
    close: () => {
      closed = true;
      void invoke("close_push_stream", { streamId }).catch(() => {});
    },
  };
};
