import type { AuthHeaderProvider } from "./auth";
import { CAP_CORE, CAP_MAIL } from "./methods";
import type { Id, MethodCall, MethodResponse, Session } from "./types";

/**
 * Low-level JMAP transport. Holds the session and turns batches of method calls into
 * a single HTTP round trip — the primitive every store action builds on. It knows
 * nothing about SolidJS or how the auth header is produced.
 */
export class JmapClient {
  #session: Session | null = null;

  constructor(
    private readonly sessionUrl: string,
    private readonly auth: AuthHeaderProvider,
  ) {}

  /** Fetch and cache the session object. Must be called before `request()`. */
  async connect(): Promise<Session> {
    const res = await fetch(this.sessionUrl, {
      headers: { Authorization: await this.auth() },
    });
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
    const res = await fetch(this.session.apiUrl, {
      method: "POST",
      headers: {
        Authorization: await this.auth(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ using, methodCalls }),
    });
    if (!res.ok) {
      throw new Error(`JMAP request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { methodResponses: MethodResponse[] };
    return body.methodResponses;
  }
}
