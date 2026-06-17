// Unit tests for the Phase-2 edit transforms (base-id resolution, the editable-event working copy,
// and the minimal-patch builder). The governing invariant: open + save with NO edits ⇒ empty patch /
// true no-op; normalize/drop only CHANGED values; present-but-uneditable props (recurrenceRule,
// participants) carry through untouched and never appear in a patch.

import { describe, expect, it } from "vitest";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import {
  baseEventIdCandidates,
  type EditableEvent,
  editableEventError,
  editableToEvent,
  editableToPatch,
  editableWhen,
  eventMayWrite,
  eventToEditable,
  pickBaseEvent,
  resolveBaseEventId,
} from "./calendar";

function event(partial: Partial<CalendarEvent>): CalendarEvent {
  return { "@type": "Event", id: "e", ...partial };
}

describe("resolveBaseEventId", () => {
  it("matches the longest base id that is a suffix of a synthetic id", () => {
    // Live finding: a synthetic occurrence id is `<variable-width prefix><baseId>`, always ending in
    // the base id (e.g. base `bc` → `eaaaabc`, `baaaaabc`).
    expect(resolveBaseEventId("eaaaabc", ["w", "x", "ba", "bb", "bc"])).toBe("bc");
    expect(resolveBaseEventId("baaaaabc", ["w", "x", "ba", "bb", "bc"])).toBe("bc");
    expect(resolveBaseEventId("eaaaaav", ["u", "v"])).toBe("v");
  });

  it("prefers the longest suffix when base ids are suffixes of one another", () => {
    expect(resolveBaseEventId("eaaaaabc", ["c", "bc"])).toBe("bc");
  });

  it("resolves a non-synthetic id to itself", () => {
    expect(resolveBaseEventId("u", ["u", "v"])).toBe("u");
  });

  it("returns null when no base id is a suffix", () => {
    expect(resolveBaseEventId("eaaaaaz", ["u", "v"])).toBeNull();
    expect(resolveBaseEventId("anything", [])).toBeNull();
  });
});

describe("baseEventIdCandidates + pickBaseEvent (suffix-collision disambiguation)", () => {
  it("returns every suffix-matching base id, longest first", () => {
    // The synthetic prefix always ends in `a`, so base `bc` and base `abc` both qualify for an
    // occurrence of `bc` (`…abc`): both must surface as candidates for content disambiguation.
    expect(baseEventIdCandidates("eaaaabc", ["x", "bc", "abc"])).toEqual(["abc", "bc"]);
    expect(baseEventIdCandidates("eaaaaav", ["u", "v"])).toEqual(["v"]);
  });

  it("picks the lone candidate without needing the occurrence", () => {
    const only = event({ id: "v", title: "Lunch" });
    expect(pickBaseEvent(undefined, [only])).toBe(only);
    expect(pickBaseEvent(undefined, [])).toBeNull();
  });

  it("disambiguates colliding candidates by the occurrence's title", () => {
    // Occurrence of base `bc` ("Standup") collides with base `abc` ("Other"). The title match wins,
    // so the longer (wrong) id does NOT — this is what stops an edit hitting the wrong event.
    const occ = event({ id: "eaaaabc", title: "Standup", recurrenceId: "2026-07-13T09:00:00" });
    const wrong = event({ id: "abc", title: "Other" });
    const right = event({
      id: "bc",
      title: "Standup",
      recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly" },
    });
    expect(pickBaseEvent(occ, [wrong, right])).toBe(right);
  });

  it("prefers a recurring base for a recurring occurrence when titles tie", () => {
    const occ = event({ id: "eaaaabc", title: "Sync", recurrenceId: "2026-07-13T09:00:00" });
    const plain = event({ id: "abc", title: "Sync" });
    const recurring = event({
      id: "bc",
      title: "Sync",
      recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly" },
    });
    expect(pickBaseEvent(occ, [plain, recurring])).toBe(recurring);
  });

  it("fails safe (null) when collisions can't be disambiguated", () => {
    const a = event({ id: "abc", title: "A" });
    const b = event({ id: "bc", title: "B" });
    // No occurrence → no signal → refuse rather than guess the longest id.
    expect(pickBaseEvent(undefined, [a, b])).toBeNull();
    // Occurrence title matches none → refuse.
    expect(pickBaseEvent(event({ id: "eaaaabc", title: "Z" }), [a, b])).toBeNull();
    // Two candidates share the title and neither (or both) recurs → refuse.
    const s1 = event({ id: "abc", title: "Same" });
    const s2 = event({ id: "bc", title: "Same" });
    expect(pickBaseEvent(event({ id: "eaaaabc", title: "Same" }), [s1, s2])).toBeNull();
  });
});

describe("eventMayWrite", () => {
  const cal = (rights: Partial<Calendar["myRights"]>): Calendar => ({
    id: "b",
    name: "Cal",
    description: null,
    color: null,
    timeZone: null,
    sortOrder: 0,
    isDefault: true,
    isSubscribed: false,
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: false,
      mayWriteOwn: false,
      mayUpdatePrivate: false,
      mayRSVP: false,
      mayShare: false,
      mayDelete: false,
      ...rights,
    },
  });

  it("is true when any containing calendar grants mayWriteAll or mayWriteOwn", () => {
    expect(
      eventMayWrite(event({ calendarIds: { b: true } }), { b: cal({ mayWriteAll: true }) }),
    ).toBe(true);
    expect(
      eventMayWrite(event({ calendarIds: { b: true } }), { b: cal({ mayWriteOwn: true }) }),
    ).toBe(true);
  });

  it("is false for a read-only calendar, a missing calendar, or a falsy membership", () => {
    expect(eventMayWrite(event({ calendarIds: { b: true } }), { b: cal({}) })).toBe(false);
    expect(eventMayWrite(event({ calendarIds: { b: true } }), {})).toBe(false);
    expect(
      eventMayWrite(event({ calendarIds: { b: false as unknown as true } }), {
        b: cal({ mayWriteAll: true }),
      }),
    ).toBe(false);
  });
});

// A representative timed, recurring event with a location + every editable enum set — the open-time
// baseline for the edit-transform tests.
function timedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return event({
    id: "u",
    title: "Standup",
    description: "Daily sync",
    start: "2026-07-06T09:00:00",
    timeZone: "America/New_York",
    duration: "PT30M",
    status: "confirmed",
    freeBusyStatus: "busy",
    privacy: "public",
    locations: { l1: { "@type": "Location", name: "Room A" } },
    recurrenceRule: { "@type": "RecurrenceRule", frequency: "weekly" },
    ...overrides,
  });
}

function edit(base: CalendarEvent, changes: Partial<EditableEvent>): EditableEvent {
  return { ...eventToEditable(base), ...changes };
}

describe("eventToEditable", () => {
  it("derives the flat working copy from a timed event", () => {
    expect(eventToEditable(timedEvent())).toEqual<EditableEvent>({
      title: "Standup",
      description: "Daily sync",
      location: "Room A",
      allDay: false,
      start: "2026-07-06T09:00",
      end: "2026-07-06T09:30",
      timeZone: "America/New_York",
      status: "confirmed",
      freeBusyStatus: "busy",
      privacy: "public",
    });
  });

  it("shows an all-day event's inclusive last day and an empty time zone", () => {
    const allDay = event({
      title: "Trip",
      start: "2026-08-05T00:00:00",
      duration: "P3D",
      showWithoutTime: true,
      timeZone: null,
    });
    const e = eventToEditable(allDay);
    expect(e.allDay).toBe(true);
    expect(e.start).toBe("2026-08-05");
    expect(e.end).toBe("2026-08-07"); // P3D is exclusive → inclusive last day is the 7th
    expect(e.timeZone).toBe("");
  });
});

describe("editableToPatch — the no-op invariant", () => {
  it("emits an empty patch when nothing changed (round-trip)", () => {
    const base = timedEvent();
    expect(editableToPatch(base, eventToEditable(base))).toEqual({});
  });

  it("is a no-op for an all-day event too", () => {
    const base = event({
      title: "Trip",
      start: "2026-08-05T00:00:00",
      duration: "P3D",
      showWithoutTime: true,
      timeZone: null,
    });
    expect(editableToPatch(base, eventToEditable(base))).toEqual({});
  });

  it("never trims an untouched value with odd whitespace", () => {
    const base = timedEvent({ title: "Standup ", description: "note\n" });
    expect(editableToPatch(base, eventToEditable(base))).toEqual({});
  });

  it("carries a startless baseline through without emitting a spurious start", () => {
    const base = event({ id: "u", title: "Untimed" }); // no start/duration
    expect(editableToPatch(base, eventToEditable(base))).toEqual({});
  });
});

describe("editableToPatch — minimal, scoped changes", () => {
  it("emits only the changed scalar", () => {
    const base = timedEvent();
    expect(editableToPatch(base, edit(base, { title: "Standup v2" }))).toEqual({
      title: "Standup v2",
    });
  });

  it("removes a scalar cleared to blank", () => {
    const base = timedEvent();
    expect(editableToPatch(base, edit(base, { description: "" }))).toEqual({ description: null });
  });

  it("recomputes duration when the end moves, leaving start untouched", () => {
    const base = timedEvent();
    expect(editableToPatch(base, edit(base, { end: "2026-07-06T10:00" }))).toEqual({
      duration: "PT1H",
    });
  });

  it("emits start and a recomputed duration when the start moves", () => {
    const base = timedEvent();
    expect(editableToPatch(base, edit(base, { start: "2026-07-06T08:00" }))).toEqual({
      start: "2026-07-06T08:00:00",
      duration: "PT1H30M",
    });
  });

  it("rewrites the when properties when toggled to all-day", () => {
    const base = timedEvent();
    expect(editableToPatch(base, edit(base, { allDay: true }))).toEqual({
      start: "2026-07-06T00:00:00",
      duration: "P1D",
      timeZone: null,
      showWithoutTime: true,
    });
  });

  it("sets a new location name in place, preserving the entry's other fields", () => {
    const base = timedEvent();
    expect(editableToPatch(base, edit(base, { location: "Room B" }))).toEqual({
      locations: { l1: { "@type": "Location", name: "Room B" } },
    });
  });

  it("adds a location to an event that had none", () => {
    const base = timedEvent({ locations: undefined });
    expect(editableToPatch(base, edit(base, { location: "Room C" }))).toEqual({
      locations: { l1: { "@type": "Location", name: "Room C" } },
    });
  });

  it("keys off the first TRUTHY location, not a null entries[0] (no-op holds)", () => {
    // A degenerate map whose first entry is null: eventToEditable seeds from the first truthy location,
    // so the location rebuild must compare against THAT, not the null entry — else open+save spuriously
    // patches.
    const base = timedEvent({
      locations: {
        l0: undefined,
        l1: { "@type": "Location", name: "Room A" },
      } as unknown as NonNullable<CalendarEvent["locations"]>,
    });
    expect(eventToEditable(base).location).toBe("Room A");
    expect(editableToPatch(base, eventToEditable(base))).toEqual({});
  });

  it("changes an enum and removes one cleared to the default", () => {
    const base = timedEvent();
    expect(editableToPatch(base, edit(base, { status: "tentative" }))).toEqual({
      status: "tentative",
    });
    expect(editableToPatch(base, edit(base, { privacy: "" }))).toEqual({ privacy: null });
  });

  it("never names recurrenceRule or participants (present-but-uneditable carry through)", () => {
    const base = timedEvent({
      participants: { p1: { "@type": "Participant", name: "Ada", roles: { attendee: true } } },
    });
    const patch = editableToPatch(base, edit(base, { title: "Renamed" }));
    expect(patch).toEqual({ title: "Renamed" });
    expect("recurrenceRule" in patch).toBe(false);
    expect("participants" in patch).toBe(false);
  });
});

describe("editableToEvent — optimistic event", () => {
  it("applies the edits and carries un-edited properties through", () => {
    const base = timedEvent();
    const next = editableToEvent(base, edit(base, { title: "Renamed" }));
    expect(next.title).toBe("Renamed");
    expect(next.recurrenceRule).toEqual({ "@type": "RecurrenceRule", frequency: "weekly" });
    expect(next.calendarIds).toEqual(base.calendarIds);
  });
});

describe("editableWhen + editableEventError", () => {
  it("rejects an end before the start (only when the when changed)", () => {
    const base = timedEvent();
    const e = edit(base, { end: "2026-07-06T08:00" });
    expect(editableWhen(e)).toBeNull();
    expect(editableEventError(base, e)).toMatch(/end can't be before/i);
  });

  it("accepts an untouched (server-loaded) event", () => {
    const base = timedEvent();
    expect(editableEventError(base, eventToEditable(base))).toBeNull();
  });
});
