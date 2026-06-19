import { describe, expect, it } from "vitest";
import type { EmailSubmission, MethodResponse } from "../types";
import {
  addressBookChanges,
  addressBookGet,
  CALENDAR_EVENT_PROPERTIES,
  clearKeyword,
  contactCardChanges,
  contactCardGet,
  contactCardQuery,
  DETAIL_PROPERTIES,
  emailGet,
  emailQuery,
  emailQueryChanges,
  emailSet,
  emailSubmissionSet,
  identityGet,
  idsFromContactQuery,
  idsFromQuery,
  JmapMethodError,
  keywordPatch,
  LIST_PROPERTIES,
  mailboxGet,
  methodResult,
  movePatch,
  setKeyword,
  setResult,
  threadGet,
} from "./index";

describe("mailboxGet", () => {
  it("defaults to all mailboxes (ids: null)", () => {
    expect(mailboxGet("acc", "mb")).toEqual(["Mailbox/get", { accountId: "acc", ids: null }, "mb"]);
  });

  it("includes properties when given", () => {
    const [, args] = mailboxGet("acc", "mb", { properties: ["id", "role"] });
    expect(args.properties).toEqual(["id", "role"]);
  });
});

describe("emailQuery", () => {
  it("defaults to newest-first and derives the filter from mailboxId", () => {
    const [name, args, callId] = emailQuery("acc", "q", {
      mailboxId: "inbox",
      collapseThreads: true,
    });
    expect(name).toBe("Email/query");
    expect(callId).toBe("q");
    expect(args.filter).toEqual({ inMailbox: "inbox" });
    expect(args.sort).toEqual([{ property: "receivedAt", isAscending: false }]);
    expect(args.collapseThreads).toBe(true);
  });

  it("lets an explicit filter override the mailboxId shorthand", () => {
    const [, args] = emailQuery("acc", "q", {
      mailboxId: "inbox",
      filter: { hasKeyword: "$flagged" },
    });
    expect(args.filter).toEqual({ hasKeyword: "$flagged" });
  });

  it("passes through windowing options", () => {
    const [, args] = emailQuery("acc", "q", { position: 50, limit: 25, calculateTotal: true });
    expect(args).toMatchObject({ position: 50, limit: 25, calculateTotal: true });
  });

  it("passes through anchor-based windowing and omits position", () => {
    const [, args] = emailQuery("acc", "q", { anchor: "e9", anchorOffset: 1, limit: 50 });
    expect(args).toMatchObject({ anchor: "e9", anchorOffset: 1, limit: 50 });
    expect(args).not.toHaveProperty("position");
  });

  it("emits anchorOffset 0 (does not drop a falsy offset)", () => {
    const [, args] = emailQuery("acc", "q", { anchor: "e9", anchorOffset: 0 });
    expect(args).toMatchObject({ anchor: "e9", anchorOffset: 0 });
  });
});

describe("emailGet back-reference", () => {
  it("builds a #ids result reference from a query and omits a literal ids", () => {
    const [name, args] = emailGet("acc", "g", {
      idsRef: idsFromQuery("q"),
      properties: LIST_PROPERTIES,
    });
    expect(name).toBe("Email/get");
    expect(args["#ids"]).toEqual({ resultOf: "q", name: "Email/query", path: "/ids" });
    expect(args).not.toHaveProperty("ids");
    expect(args.properties).toBe(LIST_PROPERTIES);
  });

  it("uses literal ids when no reference is given", () => {
    const [, args] = emailGet("acc", "g", { ids: ["e1", "e2"] });
    expect(args.ids).toEqual(["e1", "e2"]);
    expect(args).not.toHaveProperty("#ids");
  });

  it("forwards body-value fetch flags", () => {
    const [, args] = emailGet("acc", "g", { ids: ["e1"], fetchHTMLBodyValues: true });
    expect(args.fetchHTMLBodyValues).toBe(true);
  });
});

describe("emailQueryChanges", () => {
  it("carries sinceQueryState + filter/sort but never query-only window args", () => {
    const [name, args] = emailQueryChanges("acc", "state-1", "qc", {
      mailboxId: "inbox",
      collapseThreads: true,
      maxChanges: 50,
    });
    expect(name).toBe("Email/queryChanges");
    expect(args.sinceQueryState).toBe("state-1");
    expect(args.filter).toEqual({ inMailbox: "inbox" });
    expect(args.sort).toEqual([{ property: "receivedAt", isAscending: false }]);
    expect(args.maxChanges).toBe(50);
    // `limit`/`position`/`anchor` are not valid Foo/queryChanges arguments.
    expect(args).not.toHaveProperty("limit");
    expect(args).not.toHaveProperty("position");
    expect(args).not.toHaveProperty("anchor");
  });
});

describe("keyword patch helpers", () => {
  it("setKeyword builds a presence pointer set to true", () => {
    expect(setKeyword("$seen")).toEqual({ "keywords/$seen": true });
  });

  it("clearKeyword builds a presence pointer set to null (removal)", () => {
    expect(clearKeyword("$flagged")).toEqual({ "keywords/$flagged": null });
  });

  it("keywordPatch toggles between the set and clear forms", () => {
    expect(keywordPatch("$seen", true)).toEqual({ "keywords/$seen": true });
    expect(keywordPatch("$seen", false)).toEqual({ "keywords/$seen": null });
  });

  it("movePatch removes the from-mailbox pointer and adds the to-mailbox pointer", () => {
    expect(movePatch("mbA", "mbB")).toEqual({
      "mailboxIds/mbA": null,
      "mailboxIds/mbB": true,
    });
  });
});

describe("emailSet", () => {
  it("forwards create/update/destroy and tags the call id", () => {
    const [name, args, callId] = emailSet("acc", "set", {
      update: { e1: { "keywords/$seen": true } },
      destroy: ["e2"],
    });
    expect(name).toBe("Email/set");
    expect(callId).toBe("set");
    expect(args).toEqual({
      accountId: "acc",
      update: { e1: { "keywords/$seen": true } },
      destroy: ["e2"],
    });
  });

  it("omits absent sections (no empty create/update/destroy keys)", () => {
    const [, args] = emailSet("acc", "set", { update: { e1: { "keywords/$flagged": null } } });
    expect(args).not.toHaveProperty("create");
    expect(args).not.toHaveProperty("destroy");
    expect(args.update).toEqual({ e1: { "keywords/$flagged": null } });
  });
});

describe("setResult", () => {
  it("normalizes the per-item maps to {} and destroyed to [] when absent", () => {
    const responses: MethodResponse[] = [
      ["Email/set", { newState: "s2", updated: { e1: null } }, "set"],
    ];
    const r = setResult(responses, "set");
    expect(r.newState).toBe("s2");
    expect(r.updated).toEqual({ e1: null });
    expect(r.created).toEqual({});
    expect(r.destroyed).toEqual([]);
    expect(r.notCreated).toEqual({});
    expect(r.notUpdated).toEqual({});
    expect(r.notDestroyed).toEqual({});
  });

  it("surfaces the notUpdated SetErrors that ride on a successful response", () => {
    const responses: MethodResponse[] = [
      [
        "Email/set",
        { newState: "s3", notUpdated: { e1: { type: "forbidden", description: "no rights" } } },
        "set",
      ],
    ];
    const r = setResult(responses, "set");
    expect(Object.keys(r.notUpdated)).toEqual(["e1"]);
    expect(r.notUpdated.e1?.type).toBe("forbidden");
  });

  it("throws a JmapMethodError on a method-level error (via methodResult)", () => {
    const responses: MethodResponse[] = [["error", { type: "accountNotFound" }, "set"]];
    expect(() => setResult(responses, "set")).toThrow(JmapMethodError);
  });

  it("throws on a missing newState by default (protects cursor-persisting callers)", () => {
    // An all-failed /set: every record refused, so Stalwart omits the newState cursor token.
    const responses: MethodResponse[] = [
      ["EmailSubmission/set", { notCreated: { sub: { type: "invalidProperties" } } }, "set"],
    ];
    expect(() => setResult(responses, "set")).toThrow(/no string newState/);
  });

  it("tolerates a missing newState with requireNewState:false, reading the not* maps", () => {
    // The refused-submission shape Stalwart actually returns (no newState/oldState). A caller that
    // never persists the cursor reads notCreated without the strict check throwing first.
    const responses: MethodResponse[] = [
      ["EmailSubmission/set", { notCreated: { sub: { type: "invalidProperties" } } }, "set"],
    ];
    const r = setResult(responses, "set", { requireNewState: false });
    expect(r.newState).toBe(""); // defaulted (oldState ?? ""), never persisted by such callers
    expect(r.oldState).toBeNull();
    expect(r.notCreated.sub?.type).toBe("invalidProperties");
  });
});

describe("identityGet", () => {
  it("defaults to all identities (ids: null)", () => {
    expect(identityGet("acc", "i")).toEqual(["Identity/get", { accountId: "acc", ids: null }, "i"]);
  });

  it("forwards an explicit id list", () => {
    const [, args] = identityGet("acc", "i", ["id1"]);
    expect(args.ids).toEqual(["id1"]);
  });
});

describe("emailSubmissionSet", () => {
  it("creates a submission that references the draft creation id and files it on success", () => {
    const [name, args, callId] = emailSubmissionSet("acc", "sub", {
      create: { sub: { identityId: "id1", emailId: "#draft" } },
      onSuccessUpdateEmail: {
        "#sub": {
          "keywords/$draft": null,
          "keywords/$seen": true,
          "mailboxIds/d": null,
          "mailboxIds/s": true,
        },
      },
    });
    expect(name).toBe("EmailSubmission/set");
    expect(callId).toBe("sub");
    expect(args).toEqual({
      accountId: "acc",
      create: { sub: { identityId: "id1", emailId: "#draft" } },
      onSuccessUpdateEmail: {
        "#sub": {
          "keywords/$draft": null,
          "keywords/$seen": true,
          "mailboxIds/d": null,
          "mailboxIds/s": true,
        },
      },
    });
  });

  it("omits absent optional sections", () => {
    const [, args] = emailSubmissionSet("acc", "sub", {
      create: { sub: { identityId: "id1", emailId: "#draft" } },
    });
    expect(args).not.toHaveProperty("onSuccessUpdateEmail");
    expect(args).not.toHaveProperty("onSuccessDestroyEmail");
  });

  it("setResult parses an EmailSubmission/set response and matches the FIRST same-id response", () => {
    // onSuccessUpdateEmail makes the server emit a second response (the implicit Email/set)
    // under the SAME call id; setResult must surface the submission's maps, not the Email/set's.
    const responses: MethodResponse[] = [
      ["EmailSubmission/set", { newState: "s2", created: { sub: { id: "b" } } }, "sub"],
      ["Email/set", { newState: "s3", updated: { e1: null } }, "sub"],
    ];
    const r = setResult<EmailSubmission>(responses, "sub");
    expect(r.created.sub?.id).toBe("b");
    expect(r.updated).toEqual({}); // not the trailing Email/set's `updated`
    expect(r.notCreated).toEqual({});
  });
});

describe("contacts builders", () => {
  it("addressBookGet defaults to all books (ids: null)", () => {
    expect(addressBookGet("acc", "ab")).toEqual([
      "AddressBook/get",
      { accountId: "acc", ids: null },
      "ab",
    ]);
  });

  it("addressBookChanges carries the sinceState cursor", () => {
    expect(addressBookChanges("acc", "s1", "abc")).toEqual([
      "AddressBook/changes",
      { accountId: "acc", sinceState: "s1" },
      "abc",
    ]);
  });

  it("contactCardQuery omits sort by default (server rejects ContactCard sort)", () => {
    const [name, args, callId] = contactCardQuery("acc", "q");
    expect(name).toBe("ContactCard/query");
    expect(callId).toBe("q");
    expect(args).toEqual({ accountId: "acc" });
    expect(args).not.toHaveProperty("sort");
  });

  it("contactCardQuery forwards an explicit filter and windowing", () => {
    const [, args] = contactCardQuery("acc", "q", {
      filter: { inAddressBook: "b" },
      limit: 50,
      calculateTotal: true,
    });
    expect(args).toMatchObject({ filter: { inAddressBook: "b" }, limit: 50, calculateTotal: true });
  });

  it("contactCardGet builds a #ids back-reference from a query and omits literal ids", () => {
    const [name, args] = contactCardGet("acc", "g", { idsRef: idsFromContactQuery("q") });
    expect(name).toBe("ContactCard/get");
    expect(args["#ids"]).toEqual({ resultOf: "q", name: "ContactCard/query", path: "/ids" });
    expect(args).not.toHaveProperty("ids");
    // No `properties` → the server returns the whole card (full-detail read).
    expect(args).not.toHaveProperty("properties");
  });

  it("contactCardGet uses literal ids when given", () => {
    const [, args] = contactCardGet("acc", "g", { ids: ["c1", "c2"] });
    expect(args.ids).toEqual(["c1", "c2"]);
    expect(args).not.toHaveProperty("#ids");
  });

  it("contactCardChanges carries the sinceState and optional maxChanges", () => {
    const [, noMax] = contactCardChanges("acc", "s1", "cc");
    expect(noMax).toEqual({ accountId: "acc", sinceState: "s1" });
    const [, withMax] = contactCardChanges("acc", "s1", "cc", 100);
    expect(withMax.maxChanges).toBe(100);
  });
});

describe("threadGet", () => {
  it("accepts a back-reference for ids", () => {
    const [name, args] = threadGet("acc", "t", {
      idsRef: { resultOf: "g", name: "Email/get", path: "/list/*/threadId" },
    });
    expect(name).toBe("Thread/get");
    expect(args["#ids"]).toEqual({ resultOf: "g", name: "Email/get", path: "/list/*/threadId" });
  });
});

describe("property sets", () => {
  it("DETAIL is a superset of LIST and adds body fields", () => {
    for (const p of LIST_PROPERTIES) expect(DETAIL_PROPERTIES).toContain(p);
    expect(DETAIL_PROPERTIES).toContain("bodyValues");
    expect(DETAIL_PROPERTIES).toContain("htmlBody");
    expect(LIST_PROPERTIES).not.toContain("bodyValues");
  });

  it("CALENDAR_EVENT_PROPERTIES covers every field the detail/edit read plus the UTC instants", () => {
    // The fields EventView renders + eventToEditable reads — a new rendered field must be added here
    // (and to the CalendarEvent type) or it silently stops loading once we request an explicit set.
    const required = [
      "id",
      "calendarIds",
      "title",
      "description",
      "start",
      "timeZone",
      "duration",
      "showWithoutTime",
      "status",
      "freeBusyStatus",
      "privacy",
      "recurrenceRule",
      "recurrenceId",
      "locations",
      "participants",
    ];
    for (const p of required) expect(CALENDAR_EVENT_PROPERTIES).toContain(p);
    // The viewer-tz conversion's reason for an explicit list — the server-computed UTC instants, which
    // a full get omits.
    expect(CALENDAR_EVENT_PROPERTIES).toContain("utcStart");
    expect(CALENDAR_EVENT_PROPERTIES).toContain("utcEnd");
  });
});

describe("methodResult", () => {
  const responses: MethodResponse[] = [
    ["Email/query", { ids: ["e1"] }, "q"],
    ["error", { type: "invalidArguments" }, "bad"],
  ];

  it("returns the args for a matching call id", () => {
    expect(methodResult(responses, "q")).toEqual({ ids: ["e1"] });
  });

  it("throws a JmapMethodError carrying the error type on an error response", () => {
    let caught: unknown;
    try {
      methodResult(responses, "bad");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JmapMethodError);
    expect((caught as JmapMethodError).type).toBe("invalidArguments");
    expect((caught as JmapMethodError).callId).toBe("bad");
    expect((caught as JmapMethodError).message).toMatch(/invalidArguments/);
  });

  it("falls back to type 'unknown' when the error args carry no type", () => {
    expect.assertions(1); // fail loudly if methodResult ever stops throwing here
    const noType: MethodResponse[] = [["error", {}, "x"]];
    try {
      methodResult(noType, "x");
    } catch (err) {
      expect((err as JmapMethodError).type).toBe("unknown");
    }
  });

  it("throws when the call id is absent", () => {
    expect(() => methodResult(responses, "missing")).toThrow(/No JMAP response/);
  });
});
