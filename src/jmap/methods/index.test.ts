import { describe, expect, it } from "vitest";
import type { MethodResponse } from "../types";
import {
  DETAIL_PROPERTIES,
  emailGet,
  emailQuery,
  emailQueryChanges,
  idsFromQuery,
  LIST_PROPERTIES,
  mailboxGet,
  methodResult,
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

  it("throws on an error response", () => {
    expect(() => methodResult(responses, "bad")).toThrow(/invalidArguments/);
  });

  it("throws when the call id is absent", () => {
    expect(() => methodResult(responses, "missing")).toThrow(/No JMAP response/);
  });
});
