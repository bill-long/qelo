// Read-only calendar against a live Stalwart (CLAUDE.md forbids mocking). Seeds JSCalendar events via
// a raw CalendarEvent/set, then drives the real loadCalendar/syncCalendar store actions and asserts
// the Calendar + CalendarEvent objects load, sort by start (server-side), expand recurrences into
// per-occurrence rows, and that a server-side create/destroy is picked up incrementally by
// syncCalendar (the Calendar/CalendarEvent /changes cursors → window re-query).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAP_CALENDARS, CAP_CORE, methodResult } from "@/jmap/methods";
import type { Id } from "@/jmap/types";
import { emptyEditableEvent, emptyRecurrence, eventToEditable } from "@/lib/calendar";
import {
  calendarAccountId,
  calendarEvents,
  calendarReady,
  calendars,
  createEvent,
  deleteEvent,
  eventIds,
  loadCalendar,
  refetchWindow,
  resetCalendar,
  resolveBaseEvent,
  saveEvent,
  syncCalendar,
} from "@/stores/calendar";
import {
  selectedEventId,
  setCalendarAnchor,
  setCalendarViewMode,
  setSelectedEventId,
} from "@/stores/ui";
import { connectTestClient, disconnectTestClient, resetStores, testClient } from "./harness";

const CALENDAR_USING = [CAP_CORE, CAP_CALENDARS];

// Resolve the CALENDAR primary account exactly as the store does (primaryAccounts[calendars]), not
// the mail account — they coincide on the dev server, but the fixtures must target the same account
// the store reads so the test stays correct if they ever differ.
function calendarAcct(): Id {
  const id = calendarAccountId();
  if (!id) throw new Error("session exposes no calendar account");
  return id;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// A local date-time string `daysFromNow` days ahead at `hour:00`, inside the agenda's today→+56d
// window so the query returns it.
function localDateTime(daysFromNow: number, hour = 9): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(hour)}:00:00`;
}

interface EventSpec {
  title: string;
  start: string;
  duration?: string;
  weekly?: boolean;
}

describe("calendar (live Stalwart)", () => {
  const createdIds: Id[] = [];

  beforeAll(connectTestClient);
  afterAll(disconnectTestClient);
  beforeEach(() => {
    resetStores(); // also resets calendar state
    // The default view mode is now "month" (a ~6-week window around today); these tests seed events
    // across a today→+56d span and assert via the agenda window, so pin agenda mode. The nav test
    // switches to month explicitly to exercise the grid window.
    setCalendarViewMode("agenda");
  });
  afterEach(async () => {
    if (createdIds.length > 0) {
      await destroyEvents(createdIds.splice(0)).catch(() => {});
    }
  });

  /** The id of the account's default calendar (every seeded event lands here). */
  async function defaultCalendarId(): Promise<Id> {
    const client = testClient();
    const resp = await client.request(
      [["Calendar/get", { accountId: calendarAcct(), ids: null }, "c"]],
      CALENDAR_USING,
    );
    const list = (methodResult(resp, "c").list ?? []) as Array<{ id: Id; isDefault: boolean }>;
    const def = list.find((c) => c.isDefault) ?? list[0];
    if (!def) throw new Error("account exposes no calendar");
    return def.id;
  }

  /** Create events in the default calendar; returns their server (base) ids, tracked for cleanup. */
  async function seedEvents(calId: Id, specs: EventSpec[]): Promise<Id[]> {
    const client = testClient();
    const create: Record<string, Record<string, unknown>> = {};
    specs.forEach((spec, i) => {
      create[`n${i}`] = {
        "@type": "Event",
        calendarIds: { [calId]: true },
        title: spec.title,
        start: spec.start,
        timeZone: "America/New_York",
        duration: spec.duration ?? "PT1H",
        ...(spec.weekly
          ? { recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly" } }
          : {}),
      };
    });
    const resp = await client.request(
      [["CalendarEvent/set", { accountId: calendarAcct(), create }, "cs"]],
      CALENDAR_USING,
    );
    const result = methodResult(resp, "cs");
    const notCreated = (result.notCreated ?? {}) as Record<string, unknown>;
    if (Object.keys(notCreated).length > 0) {
      throw new Error(`CalendarEvent/set notCreated: ${JSON.stringify(notCreated)}`);
    }
    const created = (result.created ?? {}) as Record<string, { id: Id }>;
    return specs.map((_, i) => {
      const id = created[`n${i}`]?.id;
      if (!id) throw new Error(`CalendarEvent/set did not create n${i}`);
      createdIds.push(id);
      return id;
    });
  }

  async function destroyEvents(ids: Id[]): Promise<void> {
    if (ids.length === 0) return;
    const client = testClient();
    await client.request(
      [["CalendarEvent/set", { accountId: calendarAcct(), destroy: ids }, "cd"]],
      CALENDAR_USING,
    );
  }

  /** (Re)load the calendar until `pred` holds (CalendarEvent/query may index a beat late). */
  async function loadUntil(pred: () => boolean, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      resetCalendar();
      await loadCalendar();
      if (pred()) return;
      if (Date.now() >= deadline) throw new Error("calendar never reached the expected state");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Run syncCalendar until `pred` holds (CalendarEvent/changes can lag the /set by a beat). */
  async function syncUntil(pred: () => boolean, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await syncCalendar();
      if (pred()) return;
      if (Date.now() >= deadline) throw new Error("syncCalendar never reached the expected state");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // With expandRecurrences, Stalwart rewrites EVERY event's id to a synthetic per-occurrence id (even
  // non-recurring events), so the store is keyed by those, never the base ids CalendarEvent/set
  // returns. Tests therefore assert by content (title), not by the seeded base id.

  /** Count loaded events carrying `title` (occurrences of a recurring seed share the base title). */
  function countByTitle(title: string): number {
    return Object.values(calendarEvents).filter((e) => e?.title === title).length;
  }

  it("loads the calendar + events sorted by start", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    // Seed out of order: the later event first, so a passing order assertion proves server-side sort.
    await seedEvents(calId, [
      { title: `Later ${tag}`, start: localDateTime(9, 14) },
      { title: `Earlier ${tag}`, start: localDateTime(5, 9) },
    ]);

    await loadUntil(() => countByTitle(`Earlier ${tag}`) >= 1 && countByTitle(`Later ${tag}`) >= 1);

    expect(calendarReady()).toBe(true);
    // The default calendar loaded with its rights.
    expect(calendars[calId]?.myRights.mayReadItems).toBe(true);
    // Fields captured (looked up by title — the store keys are synthetic occurrence ids).
    const ordered = eventIds()
      .map((id) => calendarEvents[id])
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    const earlier = ordered.find((e) => e.title === `Earlier ${tag}`);
    const later = ordered.find((e) => e.title === `Later ${tag}`);
    expect(earlier?.timeZone).toBe("America/New_York");
    expect(later).toBeTruthy();
    // Sorted by start: the earlier-starting event precedes the later one in the query order.
    const earlierPos = ordered.findIndex((e) => e.title === `Earlier ${tag}`);
    const laterPos = ordered.findIndex((e) => e.title === `Later ${tag}`);
    expect(earlierPos).toBeGreaterThanOrEqual(0);
    expect(earlierPos).toBeLessThan(laterPos);
  });

  it("expands a recurring event into multiple occurrences", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    const title = `Weekly ${tag}`;
    await seedEvents(calId, [{ title, start: localDateTime(3, 10), weekly: true }]);

    // A weekly event over the ~8-week window expands to several occurrences (each its own row).
    await loadUntil(() => countByTitle(title) >= 2);
    expect(countByTitle(title)).toBeGreaterThanOrEqual(2);
  });

  it("picks up a server-side create and destroy via syncCalendar", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    const [firstId] = (await seedEvents(calId, [
      { title: `First ${tag}`, start: localDateTime(4, 9) },
    ])) as [Id];

    await loadUntil(() => countByTitle(`First ${tag}`) >= 1);

    // Create a second event server-side, then sync — it should appear without a full reload.
    await seedEvents(calId, [{ title: `Second ${tag}`, start: localDateTime(6, 11) }]);
    await syncUntil(() => countByTitle(`Second ${tag}`) >= 1);
    expect(countByTitle(`Second ${tag}`)).toBe(1);

    // Destroy the first event server-side (by its base id), then sync — it should be removed.
    await destroyEvents([firstId]);
    createdIds.splice(createdIds.indexOf(firstId), 1);
    await syncUntil(() => countByTitle(`First ${tag}`) === 0);
    expect(countByTitle(`First ${tag}`)).toBe(0);
  });

  /** A loaded synthetic agenda id for the (only) event carrying `title`, or throw. */
  function occurrenceIdFor(title: string): Id {
    const id = eventIds().find((eid) => calendarEvents[eid]?.title === title);
    if (!id) throw new Error(`no loaded occurrence titled "${title}"`);
    return id;
  }

  it("resolves a synthetic occurrence to its base event and edits it, preserving recurrence", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    // A weekly event: every agenda row is a synthetic occurrence id, and the base carries the rule.
    await seedEvents(calId, [{ title: `Edit ${tag}`, start: localDateTime(4, 9), weekly: true }]);
    await loadUntil(() => countByTitle(`Edit ${tag}`) >= 2);

    // Resolve the base event behind a synthetic occurrence id (the Phase-2 blocker path).
    const occId = occurrenceIdFor(`Edit ${tag}`);
    const base = await resolveBaseEvent(occId);
    expect(base).toBeTruthy();
    if (!base) throw new Error("unreachable");
    // The base id is NOT the synthetic occurrence id, and the base carries the recurrence rule.
    expect(base.id).not.toBe(occId);
    expect(base.recurrenceRule?.frequency).toBe("weekly");

    // Edit the title + add a description via the real store action (one CalendarEvent/set update).
    const edits = { ...eventToEditable(base), title: `Edit ${tag} RENAMED`, description: "added" };
    const result = await saveEvent(occId, base.id, base, edits);
    expect(result.ok).toBe(true);

    // The change persisted (reload from scratch), the old title is gone, and the recurrence survived
    // (still expands to multiple occurrences → recurrenceRule was carried through the patch untouched).
    await loadUntil(() => countByTitle(`Edit ${tag} RENAMED`) >= 2);
    expect(countByTitle(`Edit ${tag}`)).toBe(0);
    const renamed = await resolveBaseEvent(occurrenceIdFor(`Edit ${tag} RENAMED`));
    expect(renamed?.description).toBe("added");
    expect(renamed?.recurrenceRule?.frequency).toBe("weekly");
  });

  it("creates a new event in the default calendar via the store action", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    const title = `Create ${tag}`;
    // Build the form's working copy the way the create form does: a default slot, then a title + an
    // in-window when (the editable date inputs are the 16-char datetime-local shape, no seconds).
    const start = localDateTime(5, 9).slice(0, 16);
    const end = localDateTime(5, 10).slice(0, 16);
    const edits = {
      ...emptyEditableEvent(),
      title,
      start,
      end,
      timeZone: "America/New_York",
    };

    const result = await createEvent(edits, { [calId]: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("create failed");
    createdIds.push(result.id); // the BASE id, for afterEach cleanup

    // The event persisted + is queryable (settle for the indexing lag), with the fields we sent.
    await loadUntil(() => countByTitle(title) >= 1);
    expect(countByTitle(title)).toBe(1);
    const created = Object.values(calendarEvents).find((e) => e?.title === title);
    expect(created?.timeZone).toBe("America/New_York");
    expect(created?.start?.slice(0, 16)).toBe(start);
    expect(created?.duration).toBe("PT1H");
    // Recurrence/participants weren't sent (not exposed on create) → absent.
    expect(created?.recurrenceRule).toBeUndefined();
    expect(created?.participants).toBeUndefined();
  });

  it("creates a recurring event from the recurrence editor's working copy", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    const title = `Recur ${tag}`;
    const start = localDateTime(4, 9).slice(0, 16);
    const end = localDateTime(4, 10).slice(0, 16);
    const edits = {
      ...emptyEditableEvent(),
      title,
      start,
      end,
      timeZone: "America/New_York",
      // Weekly, 4 times — the editor's working copy the way EventEditForm builds it.
      recurrence: {
        ...emptyRecurrence(),
        frequency: "weekly" as const,
        end: "count" as const,
        count: 4,
      },
    };

    const result = await createEvent(edits, { [calId]: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("create failed");
    createdIds.push(result.id);

    // It expands into multiple occurrences, and the base event carries the rule we built.
    await loadUntil(() => countByTitle(title) >= 2);
    const base = await resolveBaseEvent(occurrenceIdFor(title));
    expect(base?.recurrenceRule?.frequency).toBe("weekly");
    expect(base?.recurrenceRule?.count).toBe(4);
  });

  it("makes a plain event recurring, then edits the rule for the whole series", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    const title = `Series ${tag}`;
    // A non-recurring seed.
    await seedEvents(calId, [{ title, start: localDateTime(3, 9) }]);
    await loadUntil(() => countByTitle(title) >= 1);

    // (1) Add a weekly rule via saveEvent (the "all events" path — adds recurrenceRule to the base).
    let base = await resolveBaseEvent(occurrenceIdFor(title));
    expect(base?.recurrenceRule).toBeUndefined();
    if (!base) throw new Error("unreachable");
    let result = await saveEvent(occurrenceIdFor(title), base.id, base, {
      ...eventToEditable(base),
      recurrence: { ...emptyRecurrence(), frequency: "weekly" },
    });
    expect(result.ok).toBe(true);
    await loadUntil(() => countByTitle(title) >= 2); // now expands

    // (2) Change the rule for the whole series: weekly → daily.
    base = await resolveBaseEvent(occurrenceIdFor(title));
    expect(base?.recurrenceRule?.frequency).toBe("weekly");
    if (!base) throw new Error("unreachable");
    result = await saveEvent(occurrenceIdFor(title), base.id, base, {
      ...eventToEditable(base),
      recurrence: { ...emptyRecurrence(), frequency: "daily", end: "count", count: 5 },
    });
    expect(result.ok).toBe(true);
    await loadUntil(() => countByTitle(title) >= 2);
    const after = await resolveBaseEvent(occurrenceIdFor(title));
    expect(after?.recurrenceRule?.frequency).toBe("daily");
    expect(after?.recurrenceRule?.count).toBe(5);
  });

  it("rejects a contentless create without a round trip", async () => {
    // No title → editableHasContent is false → the store action refuses before any /set.
    const result = await createEvent(emptyEditableEvent(), { b: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("empty");
  });

  it("deletes an event via the store action, resolving the base id from the synthetic occurrence", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    const [baseId] = (await seedEvents(calId, [
      { title: `Del ${tag}`, start: localDateTime(5, 9) },
    ])) as [Id];
    await loadUntil(() => countByTitle(`Del ${tag}`) >= 1);

    // Delete via the real store action from the SYNTHETIC agenda id — deleteEvent resolves the base id
    // internally (a synthetic-id destroy is rejected, probed live) and selection clears on success.
    const occId = occurrenceIdFor(`Del ${tag}`);
    setSelectedEventId(occId);
    const result = await deleteEvent(occId);
    expect(result.ok).toBe(true);
    expect(selectedEventId()).toBeNull();
    createdIds.splice(createdIds.indexOf(baseId), 1); // destroyed server-side; drop from cleanup

    // It persisted: reload from scratch and it's gone.
    await loadUntil(() => countByTitle(`Del ${tag}`) === 0);
    expect(countByTitle(`Del ${tag}`)).toBe(0);
  });

  it("deletes a recurring event's whole series (base destroy removes every occurrence)", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    const [baseId] = (await seedEvents(calId, [
      { title: `Series ${tag}`, start: localDateTime(4, 9), weekly: true },
    ])) as [Id];
    await loadUntil(() => countByTitle(`Series ${tag}`) >= 2);

    // Deleting from any one occurrence destroys the base, which removes the WHOLE series (probed live;
    // single-occurrence delete is out of scope this milestone).
    const result = await deleteEvent(occurrenceIdFor(`Series ${tag}`));
    expect(result.ok).toBe(true);
    createdIds.splice(createdIds.indexOf(baseId), 1);

    await loadUntil(() => countByTitle(`Series ${tag}`) === 0);
    expect(countByTitle(`Series ${tag}`)).toBe(0);
  });

  /** Re-query the visible window (after a nav) until `pred` holds (indexing can lag). */
  async function navUntil(pred: () => boolean, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await refetchWindow();
      if (pred()) return;
      if (Date.now() >= deadline) throw new Error("nav window never reached the expected state");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  it("navigates to a different window and re-queries that window's events", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    // One event in the default agenda window (today→+56d) and one ~7 months out (well outside it).
    await seedEvents(calId, [{ title: `Near ${tag}`, start: localDateTime(5, 9) }]);
    const far = new Date();
    far.setDate(far.getDate() + 210);
    const farStart = `${far.getFullYear()}-${pad2(far.getMonth() + 1)}-${pad2(far.getDate())}T09:00:00`;
    await seedEvents(calId, [{ title: `Far ${tag}`, start: farStart }]);

    // Initial load (default agenda window) holds the near event, not the far one.
    await loadUntil(() => countByTitle(`Near ${tag}`) >= 1);
    expect(countByTitle(`Far ${tag}`)).toBe(0);

    // Navigate to the far event's month: the window re-query loads it and drops the near event (the
    // store is reconciled to the new window — the exact mechanism the month/week grids rely on).
    setCalendarViewMode("month");
    setCalendarAnchor(new Date(far.getFullYear(), far.getMonth(), 1));
    await navUntil(() => countByTitle(`Far ${tag}`) >= 1);
    expect(countByTitle(`Far ${tag}`)).toBe(1);
    expect(countByTitle(`Near ${tag}`)).toBe(0);
  });

  it("treats open + save with no edits as a no-op success", async () => {
    const calId = await defaultCalendarId();
    const tag = Math.random().toString(36).slice(2, 8);
    await seedEvents(calId, [{ title: `Noop ${tag}`, start: localDateTime(7, 13) }]);
    await loadUntil(() => countByTitle(`Noop ${tag}`) >= 1);

    const occId = occurrenceIdFor(`Noop ${tag}`);
    const base = await resolveBaseEvent(occId);
    if (!base) throw new Error("base event did not resolve");
    // An unchanged working copy → empty patch → ok without a round trip; the event is untouched.
    const result = await saveEvent(occId, base.id, base, eventToEditable(base));
    expect(result.ok).toBe(true);

    await loadUntil(() => countByTitle(`Noop ${tag}`) >= 1);
    expect(countByTitle(`Noop ${tag}`)).toBe(1);
  });
});
