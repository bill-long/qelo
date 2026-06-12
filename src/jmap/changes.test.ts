import { describe, expect, it, vi } from "vitest";
import { drainChanges } from "./changes";
import type { JmapClient } from "./client";
import type { MethodCall, MethodResponse } from "./types";

/** A JmapClient stand-in whose request() replays queued window responses. */
function fakeClient(windows: Array<Record<string, unknown>>): JmapClient & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    request(methodCalls: MethodCall[]): Promise<MethodResponse[]> {
      const [name, args, callId] = methodCalls[0] as MethodCall;
      calls.push(args.sinceState as string);
      const result = windows[i] ?? {};
      i += 1;
      return Promise.resolve([[name, result, callId]] as MethodResponse[]);
    },
  } as unknown as JmapClient & { calls: string[] };
}

const build =
  (callId: string) =>
  (sinceState: string): MethodCall => ["Email/changes", { accountId: "a", sinceState }, callId];

describe("drainChanges", () => {
  it("returns a single window's changes and new state", async () => {
    const client = fakeClient([
      { created: ["c1"], updated: ["u1"], destroyed: ["d1"], newState: "s2" },
    ]);
    const result = await drainChanges(client, "s1", build("ec"));
    expect(result).toEqual({
      created: ["c1"],
      updated: ["u1"],
      destroyed: ["d1"],
      newState: "s2",
    });
    expect(client.calls).toEqual(["s1"]); // one request, asked from the given state
  });

  it("follows hasMoreChanges across windows, advancing sinceState each time", async () => {
    const client = fakeClient([
      { created: ["c1"], newState: "s2", hasMoreChanges: true },
      { updated: ["u2"], destroyed: ["d2"], newState: "s3", hasMoreChanges: false },
    ]);
    const result = await drainChanges(client, "s1", build("ec"));
    expect(result.created).toEqual(["c1"]);
    expect(result.updated).toEqual(["u2"]);
    expect(result.destroyed).toEqual(["d2"]);
    expect(result.newState).toBe("s3");
    // The second window must continue from the first window's newState, not the original.
    expect(client.calls).toEqual(["s1", "s2"]);
  });

  it("propagates a request failure without advancing past the last good window", async () => {
    const client = {
      request: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as JmapClient;
    await expect(drainChanges(client, "s1", build("ec"))).rejects.toThrow("boom");
  });

  it("caps a server that never clears hasMoreChanges", async () => {
    const client = {
      request: vi.fn(async (calls: MethodCall[]) => {
        const [name, , callId] = calls[0] as MethodCall;
        return [[name, { newState: "s", hasMoreChanges: true }, callId]] as MethodResponse[];
      }),
    } as unknown as JmapClient & { request: ReturnType<typeof vi.fn> };
    await drainChanges(client, "s1", build("ec"));
    // Bounded at MAX_WINDOWS (100) rather than looping forever.
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(100);
  });
});
