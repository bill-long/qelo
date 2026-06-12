import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffDelay, type PushStatus, subscribeToChanges } from "./push";
import type { Session } from "./types";

// A session whose eventSourceUrl carries the template placeholders subscribeToChanges
// substitutes; only that field matters here.
const SESSION = {
  eventSourceUrl: "https://jmap.test/events?types={types}&closeafter={closeafter}&ping={ping}",
} as unknown as Session;

/** A controllable EventSource stand-in: tests drive open/error/state by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void): void {
    const list = this.listeners[type] ?? [];
    list.push(cb);
    this.listeners[type] = list;
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    const event = data === undefined ? {} : { data };
    for (const cb of this.listeners[type] ?? []) cb(event);
  }

  static get last(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1);
    if (!es) throw new Error("no EventSource was constructed");
    return es;
  }
}

describe("backoffDelay", () => {
  it("doubles from the base each attempt", () => {
    expect(backoffDelay(0, 1000, 30000)).toBe(1000);
    expect(backoffDelay(1, 1000, 30000)).toBe(2000);
    expect(backoffDelay(2, 1000, 30000)).toBe(4000);
  });

  it("clamps to the max and never overflows for large attempts", () => {
    expect(backoffDelay(10, 1000, 30000)).toBe(30000);
    expect(backoffDelay(1000, 1000, 30000)).toBe(30000);
  });
});

describe("subscribeToChanges", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is a no-op when EventSource is unavailable", () => {
    vi.stubGlobal("EventSource", undefined);
    const stop = subscribeToChanges(SESSION, ["Email"], { onChange: () => {} });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });

  it("substitutes the URL template (types, closeafter=no, ping=30)", () => {
    subscribeToChanges(SESSION, ["Mailbox", "Email"], { onChange: () => {} });
    expect(FakeEventSource.last.url).toBe(
      "https://jmap.test/events?types=Mailbox%2CEmail&closeafter=no&ping=30",
    );
  });

  it("reports connecting then live, and routes state changes", () => {
    const statuses: PushStatus[] = [];
    const changes: Array<[string, Record<string, string>]> = [];
    subscribeToChanges(SESSION, ["Email"], {
      onChange: (account, changed) => changes.push([account, changed]),
      onStatus: (s) => statuses.push(s),
    });
    expect(statuses).toEqual(["connecting"]);

    FakeEventSource.last.emit("open");
    expect(statuses).toEqual(["connecting", "live"]);

    FakeEventSource.last.emit("state", JSON.stringify({ changed: { acc1: { Email: "s2" } } }));
    expect(changes).toEqual([["acc1", { Email: "s2" }]]);
  });

  it("ignores malformed state payloads", () => {
    const changes: unknown[] = [];
    subscribeToChanges(SESSION, ["Email"], { onChange: (...args) => changes.push(args) });
    FakeEventSource.last.emit("open");
    FakeEventSource.last.emit("state", "not json{");
    expect(changes).toHaveLength(0);
  });

  it("does not fire onReopen on the first open", () => {
    const onReopen = vi.fn();
    subscribeToChanges(SESSION, ["Email"], { onChange: () => {}, onReopen });
    FakeEventSource.last.emit("open");
    expect(onReopen).not.toHaveBeenCalled();
  });

  it("reconnects with backoff after a drop and resyncs on reopen", () => {
    const statuses: PushStatus[] = [];
    const onReopen = vi.fn();
    subscribeToChanges(SESSION, ["Email"], {
      onChange: () => {},
      onStatus: (s) => statuses.push(s),
      onReopen,
    });
    FakeEventSource.last.emit("open");
    const dropped = FakeEventSource.last;

    // The stream drops: we close it (stopping the native retry) and go to reconnecting.
    dropped.emit("error");
    expect(dropped.closed).toBe(true);
    expect(statuses).toEqual(["connecting", "live", "reconnecting"]);
    expect(FakeEventSource.instances).toHaveLength(1); // no reconnect before the backoff

    // First retry waits backoffDelay(0) = 1000ms.
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Reopening fires onReopen (we may have missed changes while down) and goes live.
    FakeEventSource.last.emit("open");
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connecting", "live", "reconnecting", "live"]);
  });

  it("backs off exponentially across repeated failures", () => {
    subscribeToChanges(SESSION, ["Email"], { onChange: () => {} });

    // Fail to open three times; each retry waits a doubling delay (1s, 2s, 4s).
    FakeEventSource.last.emit("error"); // attempt 0 → schedule 1000ms
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.last.emit("error"); // attempt 1 → schedule 2000ms
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    FakeEventSource.last.emit("error"); // attempt 2 → schedule 4000ms
    vi.advanceTimersByTime(3999);
    expect(FakeEventSource.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("resets the backoff after a successful reopen", () => {
    subscribeToChanges(SESSION, ["Email"], { onChange: () => {} });
    FakeEventSource.last.emit("error"); // schedule 1000ms
    vi.advanceTimersByTime(1000);
    FakeEventSource.last.emit("open"); // success resets attempt → next failure waits 1000ms again
    FakeEventSource.last.emit("error");
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("stops reconnecting and closes the stream on unsubscribe", () => {
    const statuses: PushStatus[] = [];
    const stop = subscribeToChanges(SESSION, ["Email"], {
      onChange: () => {},
      onStatus: (s) => statuses.push(s),
    });
    FakeEventSource.last.emit("open");
    const es = FakeEventSource.last;

    stop();
    expect(es.closed).toBe(true);

    // A pending reconnect, if any, must not fire after unsubscribe.
    es.emit("error");
    vi.advanceTimersByTime(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
