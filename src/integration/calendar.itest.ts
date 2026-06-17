// Read-only calendar against a live Stalwart (CLAUDE.md forbids mocking). Seeds JSCalendar events via
// a raw CalendarEvent/set, then drives the real loadCalendar/syncCalendar store actions and asserts
// the Calendar + CalendarEvent objects load, sort by start (server-side), expand recurrences into
// per-occurrence rows, and that a server-side create/destroy is picked up incrementally by
// syncCalendar (the Calendar/CalendarEvent /changes cursors → window re-query).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAP_CALENDARS, CAP_CORE, methodResult } from "@/jmap/methods";
import type { Id } from "@/jmap/types";
import {
  calendarAccountId,
  calendarEvents,
  calendarReady,
  calendars,
  eventIds,
  loadCalendar,
  resetCalendar,
  syncCalendar,
} from "@/stores/calendar";
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
});
