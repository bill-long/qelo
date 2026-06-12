import type { AuthProvider } from "./auth";
import { CAP_CORE, CAP_MAIL } from "./methods";
import type { Id, MethodCall, MethodResponse, Session } from "./types";

/**
 * Thrown when a request is rejected for authentication reasons and the credentials
 * could not be recovered (token refresh failed or isn't possible). Callers should
 * treat this as "sign in again" rather than a transient transport error.
 */
export class JmapAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JmapAuthError";
  }
}

/**
 * Low-level JMAP transport. Holds the session and turns batches of method calls into
 * a single HTTP round trip — the primitive every store action builds on. It knows
 * nothing about SolidJS or how the auth header is produced.
 */
export class JmapClient {
  #session: Session | null = null;

  constructor(
    private readonly sessionUrl: string,
    private readonly auth: AuthProvider,
  ) {}

  /**
   * Fetch with the current auth header and, on a `401`, invalidate those credentials,
   * refresh once, and retry. Throws {@link JmapAuthError} when the credentials can't be
   * recovered or the retry still `401`s. Other responses (incl. non-2xx) are returned
   * for the caller to interpret.
   */
  async #fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const header = await this.auth.header();
    const res = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: header },
    });
    if (res.status !== 401) return res;

    const fresh = await this.auth.refresh(header);
    if (fresh === null) {
      throw new JmapAuthError("Authentication failed; sign in again");
    }
    const retry = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: fresh },
    });
    if (retry.status === 401) {
      throw new JmapAuthError("Authentication still failing after token refresh");
    }
    return retry;
  }

  /** Fetch and cache the session object. Must be called before `request()`. */
  async connect(): Promise<Session> {
    const res = await this.#fetch(this.sessionUrl);
    if (!res.ok) {
      throw new Error(`Session fetch failed: ${res.status} ${res.statusText}`);
    }
    this.#session = (await res.json()) as Session;
    return this.#session;
  }

  get session(): Session {
    if (!this.#session) throw new Error("JmapClient is not connected — call connect() first");
    return this.#session;
  }

  /** Primary mail-account id for the authenticated user. */
  get accountId(): Id {
    const id = this.session.primaryAccounts[CAP_MAIL];
    if (!id) throw new Error("Session has no primary account for JMAP Mail");
    return id;
  }

  /**
   * Issue one JMAP request containing one or more method calls, executed server-side
   * in order within a single round trip (later calls may reference earlier results).
   * Returns the raw method responses; callers match by call id (see `methodResult`)
   * and interpret any per-method errors. Throws only on transport/HTTP failure.
   */
  async request(
    methodCalls: MethodCall[],
    using: string[] = [CAP_CORE, CAP_MAIL],
  ): Promise<MethodResponse[]> {
    const res = await this.#fetch(this.session.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ using, methodCalls }),
    });
    if (!res.ok) {
      throw new Error(`JMAP request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { methodResponses: MethodResponse[] };
    return body.methodResponses;
  }
}
