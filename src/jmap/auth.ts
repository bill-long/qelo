// Authentication for the JMAP client.
//
// The client is auth-scheme-agnostic: on every request it asks an
// AuthHeaderProvider for the value to put in the `Authorization` header. That keeps
// the protocol layer free of any knowledge about *how* credentials are obtained.
//
// Phase 1 will add an OAuth-backed provider that fetches and refreshes a bearer
// token from the Rust side (OS keychain). Until then, `basicAuth` is a dev stopgap:
// the local Stalwart dev server accepts HTTP Basic auth, which is enough to exercise
// the whole client against real data.

/** Returns the value of the `Authorization` header, e.g. `"Bearer …"` or `"Basic …"`. */
export type AuthHeaderProvider = () => string | Promise<string>;

/**
 * Dev/test auth provider using HTTP Basic. Used in the browser/PWA dev build where the
 * OAuth flow (which needs the Rust backend) isn't available — do not ship in prod.
 */
export function basicAuth(email: string, password: string): AuthHeaderProvider {
  const header = `Basic ${btoa(`${email}:${password}`)}`;
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
