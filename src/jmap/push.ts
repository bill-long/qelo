// EventSource-based JMAP push subscription. See RFC 8620 §7.3.
//
// Pure transport: opens the event stream and reports StateChange notifications. It
// does not know about stores — the caller wires changes to sync actions.

import type { Session } from "./types";

/** RFC 8620 StateChange: per-account map of typeName → new state string. */
export interface StateChange {
  changed: Record<string, Record<string, string>>;
}

/**
 * Subscribe to server-pushed state changes. Invokes `onChange(accountId, changed)`
 * for each notification, where `changed` maps changed type names to their new state.
 * Returns an unsubscribe function. No-op (returns a noop) where EventSource is absent.
 */
export function subscribeToChanges(
  session: Session,
  types: string[],
  onChange: (accountId: string, changed: Record<string, string>) => void,
): () => void {
  if (typeof EventSource === "undefined") return () => {};

  const url = session.eventSourceUrl
    .replace("{types}", encodeURIComponent(types.join(",")))
    .replace("{closeafter}", "no")
    .replace("{ping}", "30");

  const source = new EventSource(url);
  source.addEventListener("state", (event) => {
    let change: StateChange;
    try {
      change = JSON.parse((event as MessageEvent).data) as StateChange;
    } catch {
      return; // ignore malformed payloads (e.g. ping noise)
    }
    for (const [accountId, changed] of Object.entries(change.changed ?? {})) {
      onChange(accountId, changed);
    }
  });

  return () => source.close();
}
