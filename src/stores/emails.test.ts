import { describe, expect, it } from "vitest";
import { applyQueryChanges } from "./emails";

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
