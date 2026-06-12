// Authentication for the JMAP client.
//
// The client is auth-scheme-agnostic: on every request it asks an AuthHeaderProvider
// for the value to put in the `Authorization` header. That keeps the protocol layer
// free of any knowledge about *how* credentials are obtained.
//
// `bearerAuth` is the desktop provider — it fetches an OAuth bearer token from the Rust
// side (OS keychain), which runs the Auth Code + PKCE flow and refreshes as needed.
// `basicAuth` is a dev stopgap for the browser/PWA build (no Rust backend): the local
// Stalwart dev server accepts HTTP Basic auth, which is enough to exercise the whole
// client against real data.

/** Returns the value of the `Authorization` header, e.g. `"Bearer …"` or `"Basic …"`. */
export type AuthHeaderProvider = () => string | Promise<string>;

/**
 * Dev/test auth provider using HTTP Basic. Used in the browser/PWA dev build where the
 * OAuth flow (which needs the Rust backend) isn't available — do not ship in prod.
 */
export function basicAuth(email: string, password: string): AuthHeaderProvider {
  // HTTP Basic credentials are UTF-8 (RFC 7617), but btoa only accepts Latin-1 and throws
  // on any non-ASCII char. Encode to UTF-8 bytes first so non-ASCII emails/passwords work.
  const bytes = new TextEncoder().encode(`${email}:${password}`);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  const header = `Basic ${btoa(binary)}`;
  return () => header;
}

/**
 * OAuth bearer provider: fetches the current access token (via the Rust backend,
 * which refreshes as needed) on each request. `getToken` is injected so this module
 * stays free of any Tauri coupling.
 */
export function bearerAuth(getToken: () => string | Promise<string>): AuthHeaderProvider {
  return async () => `Bearer ${await getToken()}`;
}
