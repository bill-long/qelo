import { describe, expect, it } from "vitest";
import type { MethodResponse } from "../types";
import {
  clearKeyword,
  DETAIL_PROPERTIES,
  emailGet,
  emailQuery,
  emailQueryChanges,
  emailSet,
  idsFromQuery,
  JmapMethodError,
  keywordPatch,
  LIST_PROPERTIES,
  mailboxGet,
  methodResult,
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
