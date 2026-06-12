// Shared driver for the windowed "/changes" calls (RFC 8620 §5.2). Email/changes,
// Mailbox/changes, etc. all return created/updated/destroyed id lists plus a newState,
// and any single call may cover only part of a burst (hasMoreChanges). Draining that to
// the latest state — with one cap against a pathological loop — is identical for every
// type, so it lives here rather than being recopied per store.

import type { JmapClient } from "./client";
import { methodResult } from "./methods";
import type { MethodCall } from "./types";

export interface ChangesResult {
  created: string[];
  updated: string[];
  destroyed: string[];
  /** The state token to persist as the next `sinceState`. */
  newState: string;
}

// Cap on drain iterations: each call advances the cursor, so a well-behaved server
// always terminates; the bound just stops an unexpected hasMoreChanges-forever loop.
const MAX_WINDOWS = 100;

/**
 * Drain a JMAP "/changes" method from `sinceState` to the server's latest state,
 * following `hasMoreChanges` across windows, and return the accumulated id lists plus
 * `newState`. `build(sinceState)` produces the method call for each window (its call id
 * is read back from the returned tuple). Throws on transport/auth failure — callers
 * decide how to recover (e.g. a full reload on cannotCalculateChanges).
 */
export async function drainChanges(
  client: JmapClient,
  sinceState: string,
  build: (sinceState: string) => MethodCall,
): Promise<ChangesResult> {
  const created: string[] = [];
  const updated: string[] = [];
  const destroyed: string[] = [];
  let state = sinceState;
  let more = true;
  for (let guard = 0; more && guard < MAX_WINDOWS; guard += 1) {
    const call = build(state);
    const responses = await client.request([call]);
    const r = methodResult(responses, call[2]);
    for (const id of (r.created ?? []) as string[]) created.push(id);
    for (const id of (r.updated ?? []) as string[]) updated.push(id);
    for (const id of (r.destroyed ?? []) as string[]) destroyed.push(id);
    state = (r.newState ?? state) as string;
    more = r.hasMoreChanges === true;
  }
  return { created, updated, destroyed, newState: state };
}
