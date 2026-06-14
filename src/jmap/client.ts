import type { AuthProvider } from "./auth";
import { CAP_CORE, CAP_MAIL } from "./methods";
import type { Id, MethodCall, MethodResponse, Session, UploadResponse } from "./types";

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
 * Merge an `Authorization` value into the caller's headers. Goes through the `Headers`
 * API rather than object-spread so it's correct for every `HeadersInit` form (a `Headers`
 * instance or a `[name, value][]`, not just a plain object).
 */
function withAuth(base: HeadersInit | undefined, authorization: string): Headers {
  const headers = new Headers(base);
  headers.set("Authorization", authorization);
  return headers;
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
    const res = await fetch(url, { ...init, headers: withAuth(init.headers, header) });
    if (res.status !== 401) return res;

    const fresh = await this.auth.refresh(header);
    if (fresh === null) {
      throw new JmapAuthError("Authentication failed; sign in again");
    }
    const retry = await fetch(url, { ...init, headers: withAuth(init.headers, fresh) });
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
   * Whether the primary mail account advertises `capability` in its `accountCapabilities`.
   * Email and EmailSubmission objects share one account (you submit an email by id, so the
   * submission lives where the email does), so compose uses {@link accountId} for both and
   * checks this before sending — surfacing a clear "can't send" rather than a confusing JMAP
   * error when the account lacks submission scope (e.g. a read-only token).
   */
  accountHasCapability(capability: string): boolean {
    const account = this.session.accounts[this.accountId];
    return account ? capability in account.accountCapabilities : false;
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

  /**
   * Upload a blob (an attachment's bytes) to the account's `uploadUrl` (RFC 8620 §6.1) and return
   * the server-assigned {@link UploadResponse}. This is binary transport, not a `/set` method call,
   * so it does NOT go through `request()` — but it still rides {@link #fetch}, inheriting the same
   * 401→refresh→retry auth path every JMAP call uses. The caller then references the returned
   * `blobId` in an `Email/set` attachment part; the upload itself creates no email.
   *
   * `type` becomes the upload's `Content-Type` (the server records it as the blob's type); pass the
   * file's MIME type, or a generic `application/octet-stream` when the platform gives none.
   */
  async upload(blob: Blob, type: string): Promise<UploadResponse> {
    // uploadUrl is a URI template with an `{accountId}` placeholder (RFC 8620 §6.1).
    const url = this.session.uploadUrl.replaceAll(
      "{accountId}",
      encodeURIComponent(this.accountId),
    );
    const res = await this.#fetch(url, {
      method: "POST",
      headers: { "Content-Type": type },
      body: blob,
    });
    if (!res.ok) {
      throw new Error(`JMAP upload failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as UploadResponse;
  }

  /**
   * Download a blob (an attachment's bytes) from the account's `downloadUrl` (RFC 8620 §6.2) and
   * return it as a {@link Blob}. Mirrors {@link upload}: pure authenticated transport over
   * {@link #fetch} (so a download also benefits from the 401→refresh→retry path), NOT a `/set`. A
   * plain anchor can't be used because the download endpoint requires the bearer header — hence the
   * fetch-then-Blob round trip; the store layer turns the Blob into a save.
   *
   * `type`/`name` fill the template's `{type}`/`{name}` placeholders (the server uses them for the
   * response `Content-Type` and download filename); every substituted value is percent-encoded so a
   * name with spaces or `/`, or a `type` with its `/`, can't break out of its path/query slot.
   */
  async download(blobId: Id, type: string, name: string): Promise<Blob> {
    // downloadUrl is a URI template with `{accountId}`/`{blobId}`/`{type}`/`{name}` placeholders
    // (RFC 8620 §6.2). replaceAll because a server may legitimately repeat one (e.g. {name} in both
    // the path and a filename query). encodeURIComponent never emits `$`, so none of these
    // substitutions can be mis-read as a String.replace `$&`/`$1` pattern.
    const url = this.session.downloadUrl
      .replaceAll("{accountId}", encodeURIComponent(this.accountId))
      .replaceAll("{blobId}", encodeURIComponent(blobId))
      .replaceAll("{type}", encodeURIComponent(type))
      .replaceAll("{name}", encodeURIComponent(name));
    const res = await this.#fetch(url);
    if (!res.ok) {
      throw new Error(`JMAP download failed: ${res.status} ${await res.text()}`);
    }
    return res.blob();
  }
}
