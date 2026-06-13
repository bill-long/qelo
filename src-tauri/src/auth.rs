//! OAuth 2.0 Authorization Code + PKCE for JMAP providers.
//!
//! The browser-facing dance and token storage live here (Rust) because they need the
//! OS keychain and a loopback listener; the TypeScript side only asks for a bearer
//! token via the `get_access_token` command. Chosen grant: Authorization Code + PKCE
//! (S256), the only flow supported by both Stalwart (dev) and Fastmail.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use futures_util::StreamExt as _;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tokio::sync::Notify;

const KEYCHAIN_SERVICE: &str = "com.bill.qelo.oauth";
/// Refresh a little before actual expiry to avoid using a token mid-flight.
const EXPIRY_SKEW_SECS: u64 = 30;
/// Network timeout for discovery/token/refresh requests.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for the user to complete the browser sign-in.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// Cap on the unparsed push-stream buffer (one incomplete SSE event). JMAP StateChange
/// payloads are tiny; this only guards against a server that never sends an event separator.
const MAX_PUSH_BUFFER: usize = 1024 * 1024;

/// In-memory access-token cache, keyed by provider id. Avoids a keychain read on every
/// JMAP request and — by holding the lock across refresh — serializes refreshes so
/// concurrent callers can't each spend (and invalidate) the same refresh token.
struct Cached {
    access_token: String,
    expires_at: Option<u64>,
}

fn token_cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn near_expiry(expires_at: Option<u64>) -> bool {
    expires_at
        .map(|at| now_secs() + EXPIRY_SKEW_SECS >= at)
        .unwrap_or(false)
}

/// A configured JMAP provider. Endpoints are discovered from the issuer at runtime.
struct Provider {
    issuer: &'static str,
    client_id: &'static str,
    scope: &'static str,
    session_url: &'static str,
}

fn provider(id: &str) -> Result<Provider, String> {
    match id {
        // Local dev (see dev/stalwart). Stalwart accepts any client_id with PKCE.
        "stalwart-dev" => Ok(Provider {
            issuer: "https://localhost",
            client_id: "qelo-dev",
            scope: "",
            session_url: "https://localhost/.well-known/jmap",
        }),
        // Fastmail scaffold — NOT yet usable. Fastmail has no self-serve OAuth *client*
        // registration (an account only exposes API tokens and app passwords), so there is
        // no client_id to plug in here; `"qelo"` is a placeholder. The scopes (JMAP core +
        // mail) and the loopback redirect (RFC 8252) this flow already uses are what a
        // registered client would need. Until a client_id is obtained, the realistic
        // production path for Fastmail is its API-token bearer (a manual token the user
        // pastes), which is a separate auth provider — tracked in the plan, not built here.
        "fastmail" => Ok(Provider {
            issuer: "https://api.fastmail.com",
            client_id: "qelo",
            scope: "urn:ietf:params:jmap:core urn:ietf:params:jmap:mail",
            session_url: "https://api.fastmail.com/jmap/session",
        }),
        other => Err(format!("Unknown provider: {other}")),
    }
}

/// OAuth server metadata (RFC 8414), the subset we need.
#[derive(Deserialize)]
struct Metadata {
    authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

/// The token-endpoint error body (RFC 6749 §5.2); only the `error` code matters to us.
#[derive(Deserialize)]
struct TokenError {
    error: Option<String>,
}

/// Why a refresh failed. `InvalidGrant` (RFC 6749 §5.2) means the refresh token is
/// revoked/expired — unrecoverable without a fresh interactive sign-in, so callers turn it
/// into a clean re-auth signal. `Other` is everything else (network, 5xx, malformed) and is
/// a transient error worth retrying.
enum RefreshError {
    InvalidGrant,
    Other(String),
}

/// Does an OAuth error body report `invalid_grant`? Lets a revoked refresh token surface as
/// a clean re-auth prompt instead of a generic transient failure.
fn is_invalid_grant(body: &str) -> bool {
    serde_json::from_str::<TokenError>(body)
        .ok()
        .and_then(|e| e.error)
        .as_deref()
        == Some("invalid_grant")
}

/// What we persist in the keychain per provider.
#[derive(Serialize, Deserialize)]
struct StoredTokens {
    access_token: String,
    refresh_token: Option<String>,
    /// Unix seconds when the access token expires (if known).
    expires_at: Option<u64>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_b64(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// Is `url`'s host a loopback address (localhost / 127.0.0.0/8 / ::1)? Used to scope
/// self-signed-cert trust to the local dev server — a remote host (e.g. Fastmail) is always
/// validated. Parses the authority with the `url` crate rather than splitting by hand, so
/// userinfo (`https://localhost:443@evil.com`), ports, and IPv6 literals can't smuggle a
/// non-loopback host past the check. A parse failure or missing host returns `false` (the
/// safe default: validate certs).
fn is_loopback_url(raw: &str) -> bool {
    let Ok(parsed) = ::url::Url::parse(raw) else {
        return false;
    };
    match parsed.host() {
        Some(::url::Host::Domain(domain)) => domain == "localhost",
        Some(::url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(::url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// An HTTP client that trusts the dev server's self-signed cert for loopback issuers
/// only; real providers (Fastmail) are validated normally.
fn http_client(issuer: &str) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .danger_accept_invalid_certs(is_loopback_url(issuer))
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

fn keychain(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider_id).map_err(|e| e.to_string())
}

/// Load stored tokens, distinguishing "no usable credential" (`Ok(None)` → re-auth) from
/// a transient keychain read error (`Err` → retry). A genuinely-absent entry *and* a
/// corrupt/old-format entry both map to `Ok(None)`: a corrupt entry can never parse, so
/// treating it as signed-out lets the next sign-in overwrite it, whereas returning `Err`
/// would loop forever without ever offering a clean re-auth.
fn try_load_tokens(provider_id: &str) -> Result<Option<StoredTokens>, String> {
    match keychain(provider_id)?.get_password() {
        Ok(raw) => Ok(serde_json::from_str(&raw).ok()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn save_tokens(provider_id: &str, tokens: &StoredTokens) -> Result<(), String> {
    let raw = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    keychain(provider_id)?
        .set_password(&raw)
        .map_err(|e| e.to_string())
}

/// Delete the stored credential for a provider, treating an already-absent entry as success.
fn forget_tokens(provider_id: &str) -> Result<(), String> {
    match keychain(provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn metadata(client: &reqwest::blocking::Client, issuer: &str) -> Result<Metadata, String> {
    let url = format!(
        "{}/.well-known/oauth-authorization-server",
        issuer.trim_end_matches('/')
    );
    client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json::<Metadata>())
        .map_err(|e| format!("OAuth discovery failed: {e}"))
}

fn store_token_response(
    provider_id: &str,
    resp: TokenResponse,
    prev_refresh: Option<String>,
) -> Result<StoredTokens, String> {
    let tokens = StoredTokens {
        access_token: resp.access_token,
        // Providers may omit a new refresh token on refresh; keep the previous one.
        refresh_token: resp.refresh_token.or(prev_refresh),
        expires_at: resp.expires_in.map(|secs| now_secs() + secs),
    };
    save_tokens(provider_id, &tokens)?;
    Ok(tokens)
}

/// Run the full interactive Authorization Code + PKCE flow on a blocking thread:
/// open the browser, capture the redirect on a loopback port, exchange the code.
fn login_flow(provider_id: &str) -> Result<String, String> {
    let p = provider(provider_id)?;
    let client = http_client(p.issuer)?;
    let meta = metadata(&client, p.issuer)?;

    // Loopback listener on an ephemeral port (RFC 8252 native-app redirect).
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("could not determine loopback port")?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    // PKCE + CSRF state.
    let verifier = random_b64(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);

    let mut auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        meta.authorization_endpoint,
        urlencoding::encode(p.client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&state),
        challenge,
    );
    if !p.scope.is_empty() {
        auth_url.push_str(&format!("&scope={}", urlencoding::encode(p.scope)));
    }

    open::that(&auth_url).map_err(|e| format!("could not open browser: {e}"))?;

    let code = wait_for_code(&server, &state)?;

    // Exchange the authorization code for tokens.
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", p.client_id),
        ("code_verifier", verifier.as_str()),
    ];
    let resp: TokenResponse = client
        .post(&meta.token_endpoint)
        .form(&params)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| format!("token exchange failed: {e}"))?;

    let tokens = store_token_response(provider_id, resp, None)?;
    if let Ok(mut cache) = token_cache().lock() {
        cache.insert(
            provider_id.to_string(),
            Cached {
                access_token: tokens.access_token,
                expires_at: tokens.expires_at,
            },
        );
    }
    Ok(p.session_url.to_string())
}

/// Block until the loopback receives the OAuth redirect; return the `code`. Gives up
/// after LOGIN_TIMEOUT so an abandoned sign-in doesn't hang the command forever.
fn wait_for_code(server: &tiny_http::Server, expected_state: &str) -> Result<String, String> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Err("sign-in timed out".to_string());
        };
        let request = match server.recv_timeout(remaining).map_err(|e| e.to_string())? {
            Some(request) => request,
            None => return Err("sign-in timed out".to_string()),
        };
        let url = request.url().to_string();
        let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
        // Ignore stray requests (e.g. the browser's /favicon.ico) until the redirect.
        if !path.starts_with("/callback") {
            let _ = request.respond(tiny_http::Response::empty(404));
            continue;
        }
        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        let mut error: Option<String> = None;
        for (key, value) in ::url::form_urlencoded::parse(query.as_bytes()) {
            match key.as_ref() {
                "code" => code = Some(value.into_owned()),
                "state" => state = Some(value.into_owned()),
                "error" => error = Some(value.into_owned()),
                _ => {}
            }
        }

        let outcome = if let Some(err) = error {
            Err(format!("authorization denied: {err}"))
        } else if state.as_deref() != Some(expected_state) {
            Err("state mismatch (possible CSRF)".to_string())
        } else if let Some(code) = code {
            Ok(code)
        } else {
            Err("no authorization code in redirect".to_string())
        };

        let body = match &outcome {
            Ok(_) => "Signed in to Qelo. You can close this window.",
            Err(_) => "Qelo sign-in failed. You can close this window.",
        };
        let response = tiny_http::Response::from_string(body).with_header(
            "Content-Type: text/plain; charset=utf-8"
                .parse::<tiny_http::Header>()
                .unwrap(),
        );
        let _ = request.respond(response);
        return outcome;
    }
}

fn refresh(provider_id: &str, refresh_token: &str) -> Result<StoredTokens, RefreshError> {
    let p = provider(provider_id).map_err(RefreshError::Other)?;
    let client = http_client(p.issuer).map_err(RefreshError::Other)?;
    let meta = metadata(&client, p.issuer).map_err(RefreshError::Other)?;
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", p.client_id),
    ];
    let resp = client
        .post(&meta.token_endpoint)
        .form(&params)
        .send()
        .map_err(|e| RefreshError::Other(format!("token refresh failed: {e}")))?;
    // Inspect the status before consuming the body so a 4xx `invalid_grant` (revoked token)
    // can be told apart from a transient failure — `error_for_status()` would erase that.
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        if is_invalid_grant(&body) {
            return Err(RefreshError::InvalidGrant);
        }
        return Err(RefreshError::Other(format!(
            "token refresh failed: HTTP {status}"
        )));
    }
    let resp: TokenResponse = resp
        .json()
        .map_err(|e| RefreshError::Other(format!("token refresh failed: {e}")))?;
    store_token_response(provider_id, resp, Some(refresh_token.to_string()))
        .map_err(RefreshError::Other)
}

/// Return a valid access token, or `Ok(None)` when re-authentication is required (not signed
/// in, or the refresh token is revoked/expired). `Ok(None)` is distinct from `Err` (a
/// transient keychain/network failure worth retrying): the frontend maps `None` to a clean
/// `JmapAuthError` re-auth gate, whereas a thrown `Err` is a transient transport error.
fn access_token(provider_id: &str) -> Result<Option<String>, String> {
    // Hold the cache lock across the whole operation so concurrent callers share one
    // cached token and at most one refresh runs at a time (no refresh-token races).
    let mut cache = token_cache()
        .lock()
        .map_err(|_| "token cache poisoned".to_string())?;
    if let Some(cached) = cache.get(provider_id) {
        if !near_expiry(cached.expires_at) {
            return Ok(Some(cached.access_token.clone()));
        }
    }

    let stored = match try_load_tokens(provider_id)? {
        Some(stored) => stored,
        None => return Ok(None), // not signed in → re-auth
    };
    let fresh = if near_expiry(stored.expires_at) {
        match stored.refresh_token {
            Some(rt) => match refresh(provider_id, &rt) {
                Ok(fresh) => fresh,
                // Revoked/expired refresh token: drop the dead credential so the next
                // sign-in starts clean, and tell the caller to re-authenticate.
                Err(RefreshError::InvalidGrant) => {
                    cache.remove(provider_id);
                    let _ = forget_tokens(provider_id);
                    return Ok(None);
                }
                Err(RefreshError::Other(e)) => return Err(e),
            },
            // Expired with no way to refresh → re-auth.
            None => return Ok(None),
        }
    } else {
        stored
    };

    let access_token = fresh.access_token.clone();
    cache.insert(
        provider_id.to_string(),
        Cached {
            access_token: fresh.access_token,
            expires_at: fresh.expires_at,
        },
    );
    Ok(Some(access_token))
}

/// Invalidate the cached token that produced a JMAP `401` and mint a fresh one.
///
/// Unlike `access_token`, this refreshes regardless of the clock: a token can be valid
/// by `expires_at` yet rejected server-side (revoked), and tokens minted without
/// `expires_in` are cached indefinitely — only the server's `401` reveals they are
/// stale. Returns the new token, or `None` when re-authentication is required (no usable
/// refresh token / not signed in).
///
/// Holding the cache lock across the refresh — plus the `stale_token` check — coalesces
/// concurrent `401`s into a single refresh: a caller that reaches the lock after the
/// refresh finds a token unequal to its `stale_token` and reuses it instead of spending
/// the (possibly rotated) refresh token again.
fn force_refresh(provider_id: &str, stale_token: &str) -> Result<Option<String>, String> {
    let mut cache = token_cache()
        .lock()
        .map_err(|_| "token cache poisoned".to_string())?;
    if let Some(cached) = cache.get(provider_id) {
        if cached.access_token != stale_token {
            // Another caller already refreshed while we waited on the lock.
            return Ok(Some(cached.access_token.clone()));
        }
    }

    // The cached token is the one that just failed (or there is none): replace it. A
    // keychain read error propagates as Err (transient — the caller retries) rather than
    // forcing a needless re-auth; only a genuinely-absent entry means "sign in again".
    let stored = match try_load_tokens(provider_id)? {
        Some(stored) => stored,
        None => {
            cache.remove(provider_id);
            return Ok(None);
        }
    };
    match stored.refresh_token {
        Some(rt) => match refresh(provider_id, &rt) {
            Ok(fresh) => {
                let access_token = fresh.access_token.clone();
                cache.insert(
                    provider_id.to_string(),
                    Cached {
                        access_token: fresh.access_token,
                        expires_at: fresh.expires_at,
                    },
                );
                Ok(Some(access_token))
            }
            // Revoked/expired refresh token (invalid_grant): drop the dead credential and
            // signal re-auth — returning `Ok(None)` makes the JMAP client raise a clean
            // re-auth gate instead of treating it as a transient transport error.
            Err(RefreshError::InvalidGrant) => {
                cache.remove(provider_id);
                let _ = forget_tokens(provider_id);
                Ok(None)
            }
            Err(RefreshError::Other(e)) => Err(e),
        },
        // Cannot refresh without a refresh token: drop the dead token and signal re-auth.
        None => {
            cache.remove(provider_id);
            Ok(None)
        }
    }
}

// --- Tauri commands --------------------------------------------------------

/// Run the interactive sign-in. Returns the provider's JMAP session URL.
#[tauri::command]
pub async fn oauth_login(provider_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || login_flow(&provider_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Return a valid bearer token, refreshing if needed, or `None` when the user must sign in
/// again (not signed in, or a revoked/expired refresh token). The frontend maps `None` to a
/// clean re-auth gate; an `Err` is a transient failure.
#[tauri::command]
pub async fn get_access_token(provider_id: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || access_token(&provider_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Invalidate the token that produced a JMAP `401` and return a fresh one, or `None`
/// if the user must sign in again. Called by the JMAP client to recover from `401`s.
#[tauri::command]
pub async fn refresh_access_token(
    provider_id: String,
    stale_token: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || force_refresh(&provider_id, &stale_token))
        .await
        .map_err(|e| e.to_string())?
}

/// Forget the stored tokens for a provider.
#[tauri::command]
pub fn logout(provider_id: String) -> Result<(), String> {
    if let Ok(mut cache) = token_cache().lock() {
        cache.remove(&provider_id);
    }
    forget_tokens(&provider_id)
}

// --- Push (EventSource) proxy ---------------------------------------------
//
// EventSource cannot set an Authorization header, so under OAuth the JMAP push stream is
// opened here rather than in the webview: we attach the bearer token, stream the raw SSE
// from the provider, and forward each event's data to the frontend over a Tauri channel.
// The frontend keeps owning reconnection/backoff (see src/jmap/push.ts) — this side is pure
// authenticated transport, one upstream connection per `open_push_stream` invocation.

/// One event forwarded to the frontend channel. `Open` fires once the upstream responds
/// `200` (maps to EventSource's `open`); `State` carries an SSE `state` event's `data`
/// payload verbatim for the frontend to parse (the `state` event it already listens for).
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum PushEvent {
    Open,
    State { data: String },
}

/// Cancellation handles for in-flight push streams, keyed by the frontend-supplied stream
/// id, so `close_push_stream` can promptly drop the matching upstream connection.
fn push_registry() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lock the push registry, recovering from a poisoned lock rather than propagating it. The
/// map holds only cancellation handles, so a panic elsewhere can't leave it in a state worth
/// refusing — and erroring would be worse than recovering: `Mutex` poison is sticky, so it
/// would permanently disable opening/cancelling *all* push streams for the session.
fn lock_push_registry() -> std::sync::MutexGuard<'static, HashMap<String, Arc<Notify>>> {
    push_registry().lock().unwrap_or_else(|e| e.into_inner())
}

/// A parsed Server-Sent Event: its `event` name (default `message`) and joined `data`.
#[derive(Debug, PartialEq)]
struct SseFrame {
    event: String,
    data: String,
}

/// Index where the first event separator (blank line) starts in `buf`, plus its byte
/// length, handling both `\n\n` and `\r\n\r\n`. SSE separators are ASCII, so scanning raw
/// bytes is safe even when a multi-byte UTF-8 char straddles a chunk boundary.
fn find_event_separator(buf: &[u8]) -> Option<(usize, usize)> {
    let find = |needle: &[u8]| buf.windows(needle.len()).position(|w| w == needle);
    match (find(b"\n\n"), find(b"\r\n\r\n")) {
        (Some(a), Some(b)) if a <= b => Some((a, 2)),
        (Some(_), Some(b)) => Some((b, 4)),
        (Some(a), None) => Some((a, 2)),
        (None, Some(b)) => Some((b, 4)),
        (None, None) => None,
    }
}

/// Drain every complete SSE event from `buf`, leaving any partial trailing event in place.
/// Pure (no I/O) so the framing is unit-testable. Events with no `data:` field (comment
/// pings) yield `None` and are dropped. SSE is UTF-8 by spec, so a block that isn't valid
/// UTF-8 is a protocol violation and is skipped outright rather than lossily decoded (which
/// would silently corrupt the JSON payload).
fn drain_sse_frames(buf: &mut Vec<u8>) -> Vec<SseFrame> {
    let mut frames = Vec::new();
    while let Some((end, sep_len)) = find_event_separator(buf) {
        // Parse before draining; the resulting frame owns its strings, so it doesn't borrow
        // `buf`. (A complete block never splits a multi-byte char, since the `\n`/`\r`
        // separators are ASCII and can't appear inside a UTF-8 sequence.)
        let frame = std::str::from_utf8(&buf[..end])
            .ok()
            .and_then(parse_sse_block);
        buf.drain(..end + sep_len);
        if let Some(frame) = frame {
            frames.push(frame);
        }
    }
    frames
}

/// Parse one SSE event block (the text between separators), or `None` if it carries no
/// `data`. Follows the EventSource field rules closely enough for JMAP: `event:` sets the
/// name, `data:` lines accumulate (joined by `\n`) with a single leading space stripped,
/// and `:`-comment lines plus unknown fields (`id`, `retry`) are ignored.
fn parse_sse_block(block: &str) -> Option<SseFrame> {
    let mut event = String::from("message");
    let mut data: Vec<&str> = Vec::new();
    for raw in block.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event = value.to_string(),
            "data" => data.push(value),
            _ => {} // id, retry, unknown fields: irrelevant to JMAP state changes
        }
    }
    if data.is_empty() {
        None
    } else {
        Some(SseFrame {
            event,
            data: data.join("\n"),
        })
    }
}

/// An async HTTP client for the push stream, trusting the dev server's self-signed cert for
/// loopback URLs only (mirrors `http_client`). No request timeout — the stream is long-lived
/// — but a connect timeout so opening can't hang forever.
fn async_http_client(url: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(is_loopback_url(url))
        .connect_timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Outcome of opening the SSE stream once. `Unauthorized` is split out so the caller can
/// force a token refresh and retry, distinct from a transient `Other` failure.
enum OpenError {
    Unauthorized,
    Other(String),
}

async fn open_sse(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<reqwest::Response, OpenError> {
    let resp = client
        .get(url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
        .map_err(|e| OpenError::Other(e.to_string()))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(OpenError::Unauthorized);
    }
    resp.error_for_status()
        .map_err(|e| OpenError::Other(e.to_string()))
}

/// Token reads/refreshes touch the keychain and use the blocking HTTP client, so run them
/// off the async runtime.
async fn blocking_access_token(provider_id: &str) -> Result<String, String> {
    let pid = provider_id.to_string();
    let token = tokio::task::spawn_blocking(move || access_token(&pid))
        .await
        .map_err(|e| e.to_string())??;
    // No usable token means re-auth; for the push stream that surfaces as a failed open →
    // reconnect, while the regular request path raises the JmapAuthError re-auth gate.
    token.ok_or_else(|| "not signed in; sign in again".to_string())
}

async fn blocking_force_refresh(provider_id: &str, stale: &str) -> Result<Option<String>, String> {
    let pid = provider_id.to_string();
    let stale = stale.to_string();
    tokio::task::spawn_blocking(move || force_refresh(&pid, &stale))
        .await
        .map_err(|e| e.to_string())?
}

/// Open the SSE stream with a valid bearer token, refreshing once on a `401` and retrying:
/// a token can be valid by the clock yet revoked server-side, and the long-lived push stream
/// is often the first place that surfaces.
async fn open_authenticated(
    client: &reqwest::Client,
    url: &str,
    provider_id: &str,
) -> Result<reqwest::Response, String> {
    let token = blocking_access_token(provider_id).await?;
    match open_sse(client, url, &token).await {
        Ok(resp) => Ok(resp),
        Err(OpenError::Unauthorized) => match blocking_force_refresh(provider_id, &token).await? {
            Some(fresh) => open_sse(client, url, &fresh).await.map_err(|e| match e {
                OpenError::Unauthorized => "push stream unauthorized after refresh".to_string(),
                OpenError::Other(msg) => msg,
            }),
            None => Err("push stream unauthorized; sign in again".to_string()),
        },
        Err(OpenError::Other(msg)) => Err(msg),
    }
}

/// Require the push `url` to share the provider's origin (scheme + host + port). The URL is
/// supplied by the frontend, and the stream attaches the OAuth bearer token, so without this
/// a compromised webview could point the stream at an attacker host and exfiltrate the token.
/// Pinned to the provider's `session_url` origin (the eventSourceUrl is same-origin with it).
fn ensure_provider_origin(provider_id: &str, url: &str) -> Result<(), String> {
    let p = provider(provider_id)?;
    let expected = ::url::Url::parse(p.session_url).map_err(|e| e.to_string())?;
    let requested = ::url::Url::parse(url).map_err(|_| "invalid push url".to_string())?;
    if requested.origin() == expected.origin() {
        Ok(())
    } else {
        Err("push url is not on the provider's origin".to_string())
    }
}

/// Stream upstream SSE to the channel until it ends or errors. Returns `Err` on any failure
/// the frontend should treat as a drop (and reconnect with backoff). Cancellation is handled
/// by the caller dropping this future (see `open_push_stream`), which closes the connection.
async fn run_push_stream(
    provider_id: &str,
    url: &str,
    channel: &Channel<PushEvent>,
) -> Result<(), String> {
    // Validate the origin before touching the token (see ensure_provider_origin).
    ensure_provider_origin(provider_id, url)?;
    let client = async_http_client(url)?;
    let response = open_authenticated(&client, url, provider_id).await?;
    channel.send(PushEvent::Open).map_err(|e| e.to_string())?;

    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("push stream error: {e}"))?;
        buf.extend_from_slice(&bytes);
        for frame in drain_sse_frames(&mut buf) {
            // Forward only `state` events (what the frontend listens for); pings carry no
            // data and were already dropped during parsing.
            if frame.event == "state" {
                channel
                    .send(PushEvent::State { data: frame.data })
                    .map_err(|e| e.to_string())?;
            }
        }
        // Cap the unparsed tail so a server that never sends an event separator (or a single
        // unbounded event) can't grow the buffer until OOM. Checked after draining, so a
        // legitimately large *complete* event isn't penalized.
        if buf.len() > MAX_PUSH_BUFFER {
            return Err("push stream exceeded buffer limit".to_string());
        }
    }
    Err("push stream closed by server".to_string())
}

/// Open the JMAP push (EventSource) stream for a provider, attaching the OAuth bearer token
/// the browser can't, and forward events over `on_event`. Resolves `Ok` when the frontend
/// cancels via `close_push_stream`, and `Err` when the stream drops/fails so the frontend
/// reconnects. `stream_id` is a frontend-chosen handle used to cancel this stream.
#[tauri::command]
pub async fn open_push_stream(
    provider_id: String,
    stream_id: String,
    url: String,
    on_event: Channel<PushEvent>,
) -> Result<(), String> {
    let cancel = Arc::new(Notify::new());
    // Stream ids are fresh per open (a UUID), so a collision shouldn't happen — but if one
    // ever did, cancel the displaced stream rather than orphaning its connection.
    if let Some(prev) = lock_push_registry().insert(stream_id.clone(), Arc::clone(&cancel)) {
        prev.notify_one();
    }
    // Race the stream against cancellation so a `close_push_stream` interrupts *any* phase —
    // including a connection-open that hangs after TCP connect (no read timeout is set). When
    // cancel wins, `run_push_stream`'s future is dropped, which closes the upstream connection.
    // `notify_one` stores a permit, so a cancel that arrives before this `select!` is honored.
    let result = tokio::select! {
        _ = cancel.notified() => Ok(()),
        outcome = run_push_stream(&provider_id, &url, &on_event) => outcome,
    };
    // Only remove our own handle: if a collision replaced it, the newer stream owns the entry.
    let mut reg = lock_push_registry();
    if reg.get(&stream_id).is_some_and(|h| Arc::ptr_eq(h, &cancel)) {
        reg.remove(&stream_id);
    }
    result
}

/// Stop a push stream started by `open_push_stream`, dropping its upstream connection. A
/// no-op if the stream already ended.
#[tauri::command]
pub fn close_push_stream(stream_id: String) {
    let handle = lock_push_registry().get(&stream_id).cloned();
    if let Some(cancel) = handle {
        cancel.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_state_event() {
        let mut buf = b"event: state\ndata: {\"x\":1}\n\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(
            frames,
            vec![SseFrame {
                event: "state".into(),
                data: "{\"x\":1}".into(),
            }]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn joins_multiple_data_lines() {
        let mut buf = b"data: a\ndata: b\n\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(
            frames,
            vec![SseFrame {
                event: "message".into(),
                data: "a\nb".into(),
            }]
        );
    }

    #[test]
    fn skips_comment_pings_without_data() {
        let mut buf = b": ping\n\n".to_vec();
        assert!(drain_sse_frames(&mut buf).is_empty());
    }

    #[test]
    fn skips_non_utf8_block_but_keeps_draining() {
        // A non-UTF-8 block (protocol violation) is dropped, not lossily decoded, and a
        // following valid event still parses.
        let mut buf = b"event: state\ndata: \xff\xfe\n\nevent: state\ndata: ok\n\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(
            frames,
            vec![SseFrame {
                event: "state".into(),
                data: "ok".into(),
            }]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn leaves_a_partial_trailing_event_buffered() {
        let mut buf = b"event: state\ndata: 1\n\nevent: state\ndata: 2".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "1");
        // The incomplete second event stays buffered until its terminator arrives.
        assert_eq!(String::from_utf8(buf).unwrap(), "event: state\ndata: 2");
    }

    #[test]
    fn handles_crlf_separators() {
        let mut buf = b"event: state\r\ndata: x\r\n\r\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(
            frames,
            vec![SseFrame {
                event: "state".into(),
                data: "x".into(),
            }]
        );
    }

    #[test]
    fn loopback_url_matches_only_the_exact_host() {
        assert!(is_loopback_url("https://localhost"));
        assert!(is_loopback_url(
            "https://localhost/jmap/eventsource?types=Email"
        ));
        assert!(is_loopback_url("https://127.0.0.1:8080/jmap"));
        assert!(is_loopback_url("http://localhost:1420"));
        // Bracketed IPv6 loopback literal, with and without a port.
        assert!(is_loopback_url("http://[::1]:1420"));
        assert!(is_loopback_url("https://[::1]/jmap/eventsource"));
        // A lookalike host must not be trusted as loopback.
        assert!(!is_loopback_url("https://localhost.evil.com/jmap"));
        assert!(!is_loopback_url("https://127.0.0.1.evil.com"));
        assert!(!is_loopback_url(
            "https://api.fastmail.com/jmap/eventsource"
        ));
        assert!(!is_loopback_url("https://[2001:db8::1]/jmap"));
        // Userinfo must not smuggle a loopback-looking host past the real authority.
        assert!(!is_loopback_url("https://localhost:443@evil.com/jmap"));
        assert!(!is_loopback_url("https://localhost@evil.com/jmap"));
        assert!(!is_loopback_url("https://127.0.0.1@evil.com/"));
        // A malformed URL falls back to "not loopback" (validate certs).
        assert!(!is_loopback_url("not a url"));
    }

    #[test]
    fn push_url_must_match_provider_origin() {
        // The seeded eventSourceUrl shares stalwart-dev's origin.
        assert!(
            ensure_provider_origin("stalwart-dev", "https://localhost/jmap/eventsource?x=1")
                .is_ok()
        );
        // A foreign host, a different scheme, and a different port are all rejected so a
        // compromised webview can't redirect the bearer token elsewhere.
        assert!(
            ensure_provider_origin("stalwart-dev", "https://evil.com/jmap/eventsource").is_err()
        );
        assert!(
            ensure_provider_origin("stalwart-dev", "http://localhost/jmap/eventsource").is_err()
        );
        assert!(ensure_provider_origin("stalwart-dev", "https://localhost:8443/jmap").is_err());
        assert!(ensure_provider_origin("stalwart-dev", "not a url").is_err());
        assert!(ensure_provider_origin("unknown-provider", "https://localhost/").is_err());
    }

    #[test]
    fn detects_invalid_grant_error_body() {
        assert!(is_invalid_grant(r#"{"error":"invalid_grant"}"#));
        assert!(is_invalid_grant(
            r#"{"error":"invalid_grant","error_description":"revoked"}"#
        ));
        assert!(!is_invalid_grant(r#"{"error":"invalid_client"}"#));
        assert!(!is_invalid_grant("Internal Server Error"));
        assert!(!is_invalid_grant(""));
    }
}
