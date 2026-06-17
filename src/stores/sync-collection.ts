// A generic incremental sync for a JMAP collection whose objects have STABLE ids: drain its
// "/changes", refetch the created+updated rows (minus any also destroyed in the same burst —
// destroyed wins), upsert/remove them, and return the drained newState. The shape is identical for
// AddressBook, ContactCard, Calendar, etc., so it lives here rather than being recopied per store.
//
// The caller advances its module cursor ONLY from the returned value — and only after this resolves —
// so a throw mid-drain leaves the cursor at its old value and the next sync re-drains (no stranded
// gap). NOTE: this is for stable-id collections only; an EXPANDED view (e.g. CalendarEvent with
// expandRecurrences, whose synthetic per-occurrence ids don't match the base ids /changes reports)
// must re-query instead — see stores/calendar.ts.

import { drainChanges } from "@/jmap/changes";
import type { JmapClient } from "@/jmap/client";
import { methodResult } from "@/jmap/methods";
import type { MethodCall } from "@/jmap/types";

export async function syncCollection<T extends { id: string }>(
  client: JmapClient,
  sinceState: string,
  changesCall: (since: string) => MethodCall,
  getCall: (ids: string[]) => MethodCall,
  upsert: (list: T[]) => void,
  remove: (ids: string[]) => void,
  using: string[],
): Promise<string> {
  const result = await drainChanges(client, sinceState, changesCall, using);
  const destroyed = new Set(result.destroyed);
  const changed = new Set<string>();
  for (const id of [...result.created, ...result.updated]) {
    if (!destroyed.has(id)) changed.add(id);
  }
  if (changed.size > 0) {
    // Read the response by the built call's own id (call[2]) rather than a hardcoded "get", so a
    // getCall that uses a different call id can't silently read the wrong method response.
    const call = getCall([...changed]);
    const got = await client.request([call], using);
    upsert((methodResult(got, call[2]).list ?? []) as T[]);
  }
  if (destroyed.size > 0) remove([...destroyed]);
  return result.newState;
}
