import { describe, expect, it } from "vitest";
import type { Session } from "@/jmap/types";
import {
  connectionError,
  connectionStatus,
  handlePushAuthFailure,
  providerAuthKind,
  session,
  setSession,
} from "@/stores/account";

// providerAuthKind must agree with the Rust provider registry (`provider()` in
// src-tauri/src/auth.rs): OAuth providers drive the "Sign in" button, token providers the
// paste field. These cases pin that mapping so the two registries can't silently drift.
describe("providerAuthKind", () => {
  it("classifies the pasted-token providers as token", () => {
    expect(providerAuthKind("fastmail-token")).toBe("token");
  });

  it("classifies OAuth providers as oauth", () => {
    expect(providerAuthKind("stalwart-dev")).toBe("oauth");
    expect(providerAuthKind("fastmail")).toBe("oauth");
  });

  it("defaults an unknown provider to oauth (the interactive sign-in path)", () => {
    expect(providerAuthKind("something-else")).toBe("oauth");
  });
});

// A genuine push-stream auth failure (reported by the Rust transport) must raise the same
// re-auth gate a request-path JmapAuthError does, instead of looping reconnects.
describe("handlePushAuthFailure", () => {
  it("drops the session and flips to the re-auth gate", () => {
    setSession({} as Session); // pretend we were connected
    handlePushAuthFailure();
    expect(connectionStatus()).toBe("error");
    expect(session()).toBeNull();
    expect(connectionError()).toMatch(/sign in again/i);
  });
});
