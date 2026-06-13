// Authentication for the JMAP client.
//
// The client is auth-scheme-agnostic: on every request it asks an AuthProvider for the
// `Authorization` header value, and on a 401 asks it to refresh. That keeps the protocol
// layer free of any knowledge about *how* credentials are obtained or recovered.
//
// `bearerAuth` is the desktop/production provider — it fetches and refreshes an OAuth
// bearer token from the Rust side (OS keychain) via the Auth Code + PKCE flow. `basicAuth`
// is a dev stopgap for the browser/PWA build (no Rust backend): the local Stalwart dev
// server accepts HTTP Basic auth, which is enough to exercise the whole client against
// real data.

import { JmapAuthError } from "./client";

/**
 * Supplies the `Authorization` header for JMAP requests and recovers from `401`s. The
 * protocol layer stays free of any knowledge about *how* credentials are obtained or
 * refreshed — it just asks for a header, and on a `401` asks for a fresh one.
 */
export interface AuthProvider {
  /** The `Authorization` header value for a request, e.g. `"Bearer …"` or `"Basic …"`. */
  header(): string | Promise<string>;
  /**
   * Called after a request that used `failedHeader` got a `401`. Invalidate those
   * credentials and return a fresh header to retry with, or `null` if the failure is
   * unrecoverable without user action (re-auth, or simply wrong credentials).
   */
  refresh(failedHeader: string): Promise<string | null>;
}

/**
 * Dev/test auth provider using HTTP Basic. Used in the browser/PWA dev build where the
 * OAuth flow (which needs the Rust backend) isn't available — do not ship in prod.
 * Basic credentials can't be refreshed, so a `401` means bad credentials: no retry.
 */
export function basicAuth(email: string, password: string): AuthProvider {
  // HTTP Basic credentials are UTF-8 (RFC 7617), but btoa only accepts Latin-1 and throws
  // on any non-ASCII char. Encode to UTF-8 bytes first so non-ASCII emails/passwords work.
  const bytes = new TextEncoder().encode(`${email}:${password}`);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  const header = `Basic ${btoa(binary)}`;
  return {
    header: () => header,
    refresh: () => Promise.resolve(null),
  };
}

/**
 * OAuth bearer provider: fetches the current access token (via the Rust backend, which
 * refreshes as needed) on each request, and on a `401` asks the backend to invalidate
 * the rejected token and mint a fresh one. `getToken`/`forceRefresh` are injected so
 * this module stays free of any Tauri coupling.
 *
 * `getToken` returns `null` when re-authentication is required (not signed in, or a
 * revoked/expired refresh token) — distinct from throwing, which signals a transient
 * failure. On `null`, `header()` throws {@link JmapAuthError} so the re-auth gate fires
 * even when the token expires *before* any request reaches the server (no `401` needed).
 */
export function bearerAuth(
  getToken: () => string | null | Promise<string | null>,
  forceRefresh: (staleToken: string) => Promise<string | null>,
): AuthProvider {
  return {
    async header() {
      const token = await getToken();
      if (token === null) {
        throw new JmapAuthError("Not signed in; sign in again");
      }
      return `Bearer ${token}`;
    },
    async refresh(failedHeader) {
      const staleToken = failedHeader.replace(/^Bearer /, "");
      const fresh = await forceRefresh(staleToken);
      return fresh === null ? null : `Bearer ${fresh}`;
    },
  };
}
