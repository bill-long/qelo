import { describe, expect, it } from "vitest";
import { applyQueryChanges, pruneIds, spliceBack } from "./emails";

describe("applyQueryChanges", () => {
  it("inserts a newly-arrived conversation at the top", () => {
    expect(applyQueryChanges(["a", "b", "c"], [], [{ id: "new", index: 0 }])).toEqual([
      "new",
      "a",
      "b",
      "c",
    ]);
  });

  it("removes conversations no longer in the result", () => {
    expect(applyQueryChanges(["a", "b", "c"], ["b"], [])).toEqual(["a", "c"]);
  });

  it("applies removals before insertions and respects indexes", () => {
    // 'b' leaves; 'x' arrives at index 1 of the post-removal list.
    expect(applyQueryChanges(["a", "b", "c"], ["b"], [{ id: "x", index: 1 }])).toEqual([
      "a",
      "x",
      "c",
    ]);
  });

  it("splices multiple additions at their final indices, regardless of input order", () => {
    // Sorted ascending: x@0 then y@2. Into ["a","b"]: ["x","a","b"] then y at 2.
    expect(
      applyQueryChanges(
        ["a", "b"],
        [],
        [
          { id: "y", index: 2 },
          { id: "x", index: 0 },
        ],
      ),
    ).toEqual(["x", "a", "y", "b"]);
  });

  it("clamps an out-of-range index instead of producing holes", () => {
    expect(applyQueryChanges(["a"], [], [{ id: "z", index: 99 }])).toEqual(["a", "z"]);
  });
});

describe("pruneIds", () => {
  it("keeps the survivors and records each removed id with its original index", () => {
    const { kept, rows } = pruneIds(["a", "b", "c", "d"], new Set(["b", "d"]));
    expect(kept).toEqual(["a", "c"]);
    expect(rows).toEqual([
      { id: "b", index: 1 },
      { id: "d", index: 3 },
    ]);
  });

  it("removes nothing (and records nothing) when no id matches", () => {
    const { kept, rows } = pruneIds(["a", "b"], new Set(["x"]));
    expect(kept).toEqual(["a", "b"]);
    expect(rows).toEqual([]);
  });
});

describe("spliceBack", () => {
  it("restores allowed rows at their captured positions, in ascending order", () => {
    // 'b' (idx 1) and 'd' (idx 3) were pruned out of ["a","b","c","d"], leaving ["a","c"].
    expect(
      spliceBack(
        ["a", "c"],
        [
          { id: "b", index: 1 },
          { id: "d", index: 3 },
        ],
        new Set(["b", "d"]),
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("restores only the ids the caller still wants (the server kept)", () => {
    expect(
      spliceBack(
        ["a", "c"],
        [
          { id: "b", index: 1 },
          { id: "d", index: 3 },
        ],
        new Set(["b"]),
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("skips an id a concurrent sync already re-added (no duplicate)", () => {
    // 'b' is already back in the list; re-inserting it would duplicate it and crash the <For>.
    expect(spliceBack(["a", "b", "c"], [{ id: "b", index: 1 }], new Set(["b"]))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("clamps an out-of-range captured index against a list sync has since shrunk", () => {
    expect(spliceBack(["a"], [{ id: "z", index: 5 }], new Set(["z"]))).toEqual(["a", "z"]);
  });
});
