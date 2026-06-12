import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "./auth";
import { JmapAuthError, JmapClient } from "./client";
import type { Session } from "./types";

// A minimal session whose primaryAccounts the client never needs for these tests; only
// apiUrl matters for request().
const SESSION = {
  apiUrl: "https://jmap.test/api",
  primaryAccounts: {},
} as unknown as Session;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A controllable auth provider that records the headers it hands out. */
function fakeAuth(refresh: AuthProvider["refresh"]): AuthProvider & { handed: string[] } {
  const handed: string[] = [];
  return {
    handed,
    header() {
      const h = "Bearer initial";
      handed.push(h);
      return h;
    },
    refresh,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JmapClient auth recovery", () => {
  it("attaches the auth header and does not refresh on success", async () => {
    const refresh = vi.fn();
    const auth = fakeAuth(refresh);
    fetchMock.mockResolvedValueOnce(jsonResponse(SESSION));

    const client = new JmapClient("https://jmap.test/session", auth);
    await client.connect();

    expect(refresh).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer initial");
  });

  it("on 401 refreshes once and retries with the fresh header", async () => {
    const refresh = vi.fn(async () => "Bearer refreshed");
    const auth = fakeAuth(refresh);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse(SESSION));

    const client = new JmapClient("https://jmap.test/session", auth);
    const session = await client.connect();

    expect(session.apiUrl).toBe(SESSION.apiUrl);
    // Refresh is told which header failed, and the retry uses what it returns.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("Bearer initial");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(retryInit.headers).get("Authorization")).toBe("Bearer refreshed");
  });

  it("throws JmapAuthError when refresh cannot recover (null)", async () => {
    const refresh = vi.fn(async () => null);
    const auth = fakeAuth(refresh);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));

    const client = new JmapClient("https://jmap.test/session", auth);
    await expect(client.connect()).rejects.toBeInstanceOf(JmapAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
  });

  it("throws JmapAuthError when the retry still 401s (no second refresh)", async () => {
    const refresh = vi.fn(async () => "Bearer refreshed");
    const auth = fakeAuth(refresh);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 401));

    const client = new JmapClient("https://jmap.test/session", auth);
    await expect(client.connect()).rejects.toBeInstanceOf(JmapAuthError);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers a 401 on a request() call and returns the method responses", async () => {
    const refresh = vi.fn(async () => "Bearer refreshed");
    const auth = fakeAuth(refresh);
    // connect, then the request: 401 then a successful retry carrying methodResponses.
    fetchMock
      .mockResolvedValueOnce(jsonResponse(SESSION))
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ methodResponses: [["Core/echo", {}, "0"]] }));

    const client = new JmapClient("https://jmap.test/session", auth);
    await client.connect();
    const responses = await client.request([["Core/echo", {}, "0"]]);

    expect(responses).toEqual([["Core/echo", {}, "0"]]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
