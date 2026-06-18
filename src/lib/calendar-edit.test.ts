// Unit tests for the Phase-2 edit transforms (base-id resolution, the editable-event working copy,
// and the minimal-patch builder). The governing invariant: open + save with NO edits ⇒ empty patch /
// true no-op; normalize/drop only CHANGED values; present-but-uneditable props (recurrenceRule,
// participants) carry through untouched and never appear in a patch.

import { describe, expect, it } from "vitest";
import type { Calendar, CalendarEvent } from "@/jmap/types";
import {
  baseEventIdCandidates,
  type EditableEvent,
  type EditableRecurrence,
  editableEventError,
  editableToEvent,
  editableToPatch,
  editableToRule,
  editableWhen,
  emptyEditableEvent,
  emptyRecurrence,
  eventMayDelete,
  eventMayWrite,
  eventToEditable,
  pickBaseEvent,
  recurrenceErrorMessage,
  recurrenceValid,
  resolveBaseEventId,
  ruleToEditable,
  startWeekdayCode,
  whenErrorMessage,
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

describe("eventMayDelete", () => {
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

  it("is true when any containing calendar grants mayDelete", () => {
    expect(
      eventMayDelete(event({ calendarIds: { b: true } }), { b: cal({ mayDelete: true }) }),
    ).toBe(true);
  });

  it("does not key off write rights — mayWrite without mayDelete is false", () => {
    // The gates are independent: a calendar can be writable but not deletable.
    expect(
      eventMayDelete(event({ calendarIds: { b: true } }), { b: cal({ mayWriteAll: true }) }),
    ).toBe(false);
  });

  it("is false for a non-deletable calendar, a missing calendar, or a falsy membership", () => {
    expect(eventMayDelete(event({ calendarIds: { b: true } }), { b: cal({}) })).toBe(false);
    expect(eventMayDelete(event({ calendarIds: { b: true } }), {})).toBe(false);
    expect(
      eventMayDelete(event({ calendarIds: { b: false as unknown as true } }), {
        b: cal({ mayDelete: true }),
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
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [],
        monthlyNth: false,
        end: "never",
        count: 10,
        until: "",
      },
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

// A start anchoring the weekly/monthly rule build (Mon 2026-07-06 09:00; the 6th = 1st Monday).
const START = { year: 2026, month: 7, day: 6, hour: 9, minute: 0, second: 0 };

describe("ruleToEditable", () => {
  it("returns a non-repeating copy when there's no rule (or an unknown frequency)", () => {
    expect(ruleToEditable(event({}))).toEqual(emptyRecurrence());
    expect(ruleToEditable(event({ recurrenceRule: { frequency: "hourly" } }))).toEqual(
      emptyRecurrence(),
    );
  });

  it("reads weekly byDay into weekdays + interval", () => {
    const rec = ruleToEditable(
      event({
        recurrenceRule: {
          frequency: "weekly",
          interval: 2,
          byDay: [{ day: "mo" }, { day: "we" }],
        },
      }),
    );
    expect(rec.frequency).toBe("weekly");
    expect(rec.interval).toBe(2);
    expect(rec.weekdays).toEqual(["mo", "we"]);
    expect(rec.monthlyNth).toBe(false);
  });

  it("flags monthly Nth-weekday from a byDay nthOfPeriod, and reads count", () => {
    const rec = ruleToEditable(
      event({
        recurrenceRule: { frequency: "monthly", byDay: [{ day: "tu", nthOfPeriod: 2 }], count: 5 },
      }),
    );
    expect(rec.frequency).toBe("monthly");
    expect(rec.monthlyNth).toBe(true);
    expect(rec.end).toBe("count");
    expect(rec.count).toBe(5);
  });

  it("reads an until date (date portion only)", () => {
    const rec = ruleToEditable(
      event({ recurrenceRule: { frequency: "daily", until: "2026-08-01T09:00:00" } }),
    );
    expect(rec.end).toBe("until");
    expect(rec.until).toBe("2026-08-01");
  });
});

describe("editableToRule", () => {
  const base = (over: Partial<EditableRecurrence> = {}): EditableRecurrence => ({
    ...emptyRecurrence(),
    ...over,
  });

  it("returns undefined for a non-repeating copy", () => {
    expect(editableToRule(base(), START)).toBeUndefined();
  });

  it("omits interval 1 and emits interval > 1", () => {
    expect(editableToRule(base({ frequency: "daily" }), START)).toEqual({
      "@type": "RecurrenceRule",
      frequency: "daily",
    });
    expect(editableToRule(base({ frequency: "daily", interval: 3 }), START)).toMatchObject({
      interval: 3,
    });
  });

  it("emits weekly byDay from the chosen weekdays", () => {
    expect(editableToRule(base({ frequency: "weekly", weekdays: ["mo", "th"] }), START)).toEqual({
      "@type": "RecurrenceRule",
      frequency: "weekly",
      byDay: [
        { "@type": "NDay", day: "mo" },
        { "@type": "NDay", day: "th" },
      ],
    });
  });

  it("derives monthly day-of-month vs Nth-weekday from the start", () => {
    // 2026-07-06 is the 6th (day-of-month 6) and the 1st Monday.
    expect(editableToRule(base({ frequency: "monthly", monthlyNth: false }), START)).toMatchObject({
      byMonthDay: [6],
    });
    expect(editableToRule(base({ frequency: "monthly", monthlyNth: true }), START)).toMatchObject({
      byDay: [{ "@type": "NDay", day: "mo", nthOfPeriod: 1 }],
    });
  });

  it("maps a 5th-weekday monthly start to nthOfPeriod -1 (last), so short months aren't skipped", () => {
    // 2026-07-29 is the 5th Wednesday of July; a literal nthOfPeriod:5 would skip months with only 4.
    const fifthWed = { year: 2026, month: 7, day: 29, hour: 9, minute: 0, second: 0 };
    expect(
      editableToRule(base({ frequency: "monthly", monthlyNth: true }), fifthWed),
    ).toMatchObject({
      byDay: [{ "@type": "NDay", day: "we", nthOfPeriod: -1 }],
    });
  });

  it("emits count, or an until carrying the start's time-of-day", () => {
    expect(
      editableToRule(base({ frequency: "weekly", end: "count", count: 8 }), START),
    ).toMatchObject({ count: 8 });
    expect(
      editableToRule(base({ frequency: "weekly", end: "until", until: "2026-09-01" }), START),
    ).toMatchObject({ until: "2026-09-01T09:00:00" });
  });
});

describe("recurrenceValid", () => {
  it("accepts a non-repeating copy and a well-formed rule", () => {
    expect(recurrenceValid(emptyRecurrence())).toBe(true);
    expect(recurrenceValid({ ...emptyRecurrence(), frequency: "weekly" })).toBe(true);
  });
  it("rejects interval < 1, count < 1, or an invalid until", () => {
    expect(recurrenceValid({ ...emptyRecurrence(), frequency: "daily", interval: 0 })).toBe(false);
    expect(
      recurrenceValid({ ...emptyRecurrence(), frequency: "daily", end: "count", count: 0 }),
    ).toBe(false);
    expect(
      recurrenceValid({ ...emptyRecurrence(), frequency: "daily", end: "until", until: "nope" }),
    ).toBe(false);
  });
});

describe("startWeekdayCode", () => {
  it("returns the byDay code for the form's start, or '' when unparseable", () => {
    // 2026-07-06 is a Monday.
    expect(startWeekdayCode({ ...eventToEditable(timedEvent()), start: "2026-07-06T09:00" })).toBe(
      "mo",
    );
    expect(startWeekdayCode({ ...eventToEditable(timedEvent()), start: "" })).toBe("");
  });
});

describe("when/recurrence error messages are independent and change-gated", () => {
  const base = timedEvent({ recurrenceRule: { frequency: "weekly" } });

  it("surfaces a when error and a recurrence error simultaneously (neither masks the other)", () => {
    const broken = edit(base, {
      end: "2000-01-01T00:00", // end before start → when error
      recurrence: { ...emptyRecurrence(), frequency: "weekly", interval: 0 }, // → recurrence error
    });
    expect(whenErrorMessage(base, broken)).toMatch(/end can't be before/i);
    expect(recurrenceErrorMessage(base, broken)).toMatch(/valid repeat/i);
  });

  it("does NOT flag an UNCHANGED (server-loaded) recurrence, even if the editor would reject it", () => {
    // interval 0 is impossible from ruleToEditable (it coerces to >=1), so an unchanged rule never
    // trips recurrenceErrorMessage — the display matches the change-gated Save gate.
    expect(recurrenceErrorMessage(base, eventToEditable(base))).toBeNull();
    // Once the user CHANGES it to something invalid, it's flagged.
    expect(
      recurrenceErrorMessage(
        base,
        edit(base, { recurrence: { ...emptyRecurrence(), frequency: "daily", interval: 0 } }),
      ),
    ).toMatch(/valid repeat/i);
  });

  it("validates the recurrence outright in create mode (null baseline)", () => {
    const bad: EditableEvent = {
      ...emptyEditableEvent(),
      recurrence: { ...emptyRecurrence(), frequency: "weekly", end: "count", count: 0 },
    };
    expect(recurrenceErrorMessage(null, bad)).toMatch(/valid repeat/i);
  });
});

describe("recurrence in the patch builder", () => {
  it("emits no recurrenceRule when the repeat is untouched (the no-op invariant)", () => {
    const base = timedEvent({ recurrenceRule: { frequency: "weekly", interval: 2 } });
    expect(editableToPatch(base, eventToEditable(base))).toEqual({});
  });

  it("carries an editor-inexpressible rule VERBATIM when only another field changes", () => {
    // A multi-day byMonthDay list the simple editor can't reproduce; editing the title alone must not
    // rewrite (or drop) the rule.
    const base = timedEvent({
      recurrenceRule: { frequency: "monthly", byMonthDay: [1, 15, -1] },
    });
    const patch = editableToPatch(base, edit(base, { title: "Renamed" }));
    expect(patch).toEqual({ title: "Renamed" });
    expect(patch).not.toHaveProperty("recurrenceRule");
  });

  it("emits a rebuilt rule when the repeat changes", () => {
    const base = timedEvent({ recurrenceRule: { frequency: "weekly" } });
    const patch = editableToPatch(
      base,
      edit(base, { recurrence: { ...ruleToEditable(base), interval: 3 } }),
    );
    expect(patch.recurrenceRule).toMatchObject({ frequency: "weekly", interval: 3 });
  });

  it("emits recurrenceRule: null when the repeat is turned off", () => {
    const base = timedEvent({ recurrenceRule: { frequency: "weekly" } });
    const patch = editableToPatch(base, edit(base, { recurrence: emptyRecurrence() }));
    expect(patch.recurrenceRule).toBeNull();
  });

  it("adds a rule to a non-recurring event via the optimistic rebuild", () => {
    const base = timedEvent({ recurrenceRule: undefined });
    const next = editableToEvent(
      base,
      edit(base, { recurrence: { ...emptyRecurrence(), frequency: "daily" } }),
    );
    expect(next.recurrenceRule).toMatchObject({ frequency: "daily" });
  });
});
