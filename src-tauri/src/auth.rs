//! OAuth 2.0 Authorization Code + PKCE for JMAP providers.
//!
//! The browser-facing dance and token storage live here (Rust) because they need the
//! OS keychain and a loopback listener; the TypeScript side only asks for a bearer
//! token via the `get_access_token` command. Chosen grant: Authorization Code + PKCE
//! (S256), the only flow supported by both Stalwart (dev) and Fastmail.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const KEYCHAIN_SERVICE: &str = "com.bill.qelo.oauth";
/// Refresh a little before actual expiry to avoid using a token mid-flight.
const EXPIRY_SKEW_SECS: u64 = 30;
/// Network timeout for discovery/token/refresh requests.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for the user to complete the browser sign-in.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

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
        // Fastmail registers clients manually; client_id is a placeholder until then.
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

/// An HTTP client that trusts the dev server's self-signed cert for loopback issuers
/// only; real providers (Fastmail) are validated normally.
fn http_client(issuer: &str) -> Result<reqwest::blocking::Client, String> {
    let dev_local =
        issuer.starts_with("https://localhost") || issuer.starts_with("https://127.0.0.1");
    reqwest::blocking::Client::builder()
        .danger_accept_invalid_certs(dev_local)
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
        for (key, value) in url::form_pairs(query) {
            match key.as_str() {
                "code" => code = Some(value),
                "state" => state = Some(value),
                "error" => error = Some(value),
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

/// Minimal `application/x-www-form-urlencoded` query parser (avoids pulling `url`).
mod url {
    pub fn form_pairs(query: &str) -> Vec<(String, String)> {
        if query.is_empty() {
            return Vec::new();
        }
        query
            .split('&')
            .map(|pair| {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                (decode(k), decode(v))
            })
            .collect()
    }

    fn decode(s: &str) -> String {
        urlencoding::decode(&s.replace('+', " "))
            .map(|c| c.into_owned())
            .unwrap_or_else(|_| s.to_string())
    }
}

fn refresh(provider_id: &str, refresh_token: &str) -> Result<StoredTokens, String> {
    let p = provider(provider_id)?;
    let client = http_client(p.issuer)?;
    let meta = metadata(&client, p.issuer)?;
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", p.client_id),
    ];
    let resp: TokenResponse = client
        .post(&meta.token_endpoint)
        .form(&params)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| format!("token refresh failed: {e}"))?;
    store_token_response(provider_id, resp, Some(refresh_token.to_string()))
}

fn access_token(provider_id: &str) -> Result<String, String> {
    // Hold the cache lock across the whole operation so concurrent callers share one
    // cached token and at most one refresh runs at a time (no refresh-token races).
    let mut cache = token_cache()
        .lock()
        .map_err(|_| "token cache poisoned".to_string())?;
    if let Some(cached) = cache.get(provider_id) {
        if !near_expiry(cached.expires_at) {
            return Ok(cached.access_token.clone());
        }
    }

    let stored = match try_load_tokens(provider_id)? {
        Some(stored) => stored,
        None => return Err("not signed in; sign in again".to_string()),
    };
    let fresh = if near_expiry(stored.expires_at) {
        match stored.refresh_token {
            Some(rt) => refresh(provider_id, &rt)?,
            None => {
                return Err("access token expired and no refresh token; sign in again".to_string())
            }
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
    Ok(access_token)
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
        Some(rt) => {
            let fresh = refresh(provider_id, &rt)?;
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

/// Return a valid bearer token, refreshing if needed. Errors if not signed in.
#[tauri::command]
pub async fn get_access_token(provider_id: String) -> Result<String, String> {
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
    match keychain(&provider_id)?.delete_credential() {
        Ok(()) => Ok(()),
        // Already-absent credentials are fine.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
