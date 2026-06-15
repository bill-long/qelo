//! Native "save attachment to disk" for the desktop build.
//!
//! The browser/PWA build saves attachments through an object-URL `<a download>` anchor — the
//! browser owns the download UI and picks the location, silently renaming on a name clash and never
//! telling the app where the file landed. Desktop can do better: a native Save dialog lets the user
//! pick the exact destination, so the app knows the final path and can show an accurate "Saved to
//! <path>" confirmation, and the bytes stream straight to disk instead of buffering a large
//! attachment in webview memory.
//!
//! The blob endpoint requires the JMAP bearer header, so the download can't be a plain anchor. The
//! frontend builds the templated download URL (it owns the JMAP session) and hands it here; this
//! command attaches the bearer token — which lives in the keychain, Rust-side — and streams the
//! response body to the chosen file. Because the URL is frontend-supplied and we attach a token, it
//! is pinned to the provider origin first (`ensure_provider_origin`), the same token-exfiltration
//! guard the push proxy uses. This is authenticated transport, not JMAP logic: the frontend still
//! constructs the URL and nothing here parses a JMAP response, so it doesn't duplicate the protocol
//! layer (CLAUDE.md) — it only does the two things the browser can't: pick a path and stream to it.

use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::auth::{access_token, ensure_provider_origin, force_refresh, is_loopback_url};

/// Connect timeout for the download request. Unlike the auth requests there is deliberately no
/// *total* timeout — a large attachment over a slow link can legitimately take a long time — but
/// opening the connection must not hang forever. Mirrors the push stream's `async_http_client`.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Cap on the suggested filename length (chars, to keep the truncation on a UTF-8 boundary).
const MAX_NAME_LEN: usize = 200;

/// Reduce an attacker-controlled attachment name to a bare, safe filename for the Save dialog's
/// default. The user ultimately picks the real path in the native dialog, but the *suggested* name
/// comes from the email part's `name`, which is untrusted — so strip any directory components
/// (`/` and `\`), reject `.`/`..`, drop control characters and the Windows-reserved set, and cap
/// the length. This keeps a crafted name (`../../etc/passwd`, `..\\..\\system32\\x.dll`, a
/// control-char or `C:`-prefixed name) from pre-seeding a traversal or an invalid dialog default.
/// Falls back to `"attachment"` when nothing usable remains. Mirrors the webview's own sanitization
/// of an `<a download>` filename, which the native dialog would otherwise bypass.
fn safe_file_name(raw: &str) -> String {
    // Final path component only, splitting on BOTH separators — an attachment crafted on either
    // platform could carry the other's separator (and a Windows drive prefix like `C:\` too).
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = base
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect();
    // Windows silently trims trailing dots/spaces; do it ourselves so the default name we pass is
    // the one that ends up on disk. (Leading dots are fine — a legitimate hidden-style name.)
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    let usable = !cleaned.is_empty() && cleaned != "." && cleaned != "..";
    let name = if usable { cleaned } else { "attachment" };
    name.chars().take(MAX_NAME_LEN).collect()
}

/// A blocking HTTP client for the download, trusting the dev server's self-signed cert for loopback
/// URLs only (mirrors `auth::http_client`/`async_http_client`). Connect timeout only — see
/// {@link CONNECT_TIMEOUT}.
fn download_client(url: &str) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .danger_accept_invalid_certs(is_loopback_url(url))
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Outcome of one download attempt. `Unauthorized` is split out so the caller can force a token
/// refresh and retry once, distinct from a transient `Error` (the request/request-status paths a
/// reconnect couldn't help).
enum Attempt {
    Ok(reqwest::blocking::Response),
    Unauthorized,
    Error(String),
}

/// Send the download request with a bearer token, classifying a `401` so the caller can refresh.
fn send_download(client: &reqwest::blocking::Client, url: &str, token: &str) -> Attempt {
    let resp = match client.get(url).bearer_auth(token).send() {
        Ok(resp) => resp,
        Err(e) => return Attempt::Error(format!("download request failed: {e}")),
    };
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Attempt::Unauthorized;
    }
    match resp.error_for_status() {
        Ok(resp) => Attempt::Ok(resp),
        Err(e) => Attempt::Error(format!("download failed: {e}")),
    }
}

/// Fetch the authenticated download, refreshing the token once on a `401` and retrying: a token
/// valid by the clock can still be revoked server-side, and a long-idle desktop session is a likely
/// place to hit it (mirrors the request/push paths). A `401` that survives the forced refresh — or
/// no usable credential at all — is a re-auth error.
fn fetch_authenticated(
    client: &reqwest::blocking::Client,
    url: &str,
    provider_id: &str,
) -> Result<reqwest::blocking::Response, String> {
    let token = match access_token(provider_id)? {
        Some(token) => token,
        None => return Err("not signed in; sign in again".to_string()),
    };
    match send_download(client, url, &token) {
        Attempt::Ok(resp) => Ok(resp),
        Attempt::Error(e) => Err(e),
        Attempt::Unauthorized => match force_refresh(provider_id, &token)? {
            Some(fresh) => match send_download(client, url, &fresh) {
                Attempt::Ok(resp) => Ok(resp),
                Attempt::Error(e) => Err(e),
                Attempt::Unauthorized => {
                    Err("download unauthorized after refresh; sign in again".to_string())
                }
            },
            None => Err("download unauthorized; sign in again".to_string()),
        },
    }
}

/// Stream the response body to `target` via a sibling temp file, renaming into place on success so
/// a failed or interrupted download never leaves a partial file at — or clobbers an existing file
/// the user chose to overwrite at — the destination. `copy_to` streams in fixed-size chunks, so a
/// large attachment is never fully buffered (the point of the streamed write, backlog item 5). The
/// temp file lives in the same directory as the target so the rename stays on one filesystem.
fn stream_to_file(resp: &mut reqwest::blocking::Response, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or("chosen path has no parent directory")?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment");
    let temp = parent.join(format!(".{file_name}.{:016x}.part", rand::random::<u64>()));

    let write = (|| -> Result<(), String> {
        let mut file =
            std::fs::File::create(&temp).map_err(|e| format!("could not create file: {e}"))?;
        resp.copy_to(&mut file)
            .map_err(|e| format!("download write failed: {e}"))?;
        // Flush to disk before the rename so the finalized file is complete.
        file.sync_all().map_err(|e| format!("flush failed: {e}"))
    })();

    match write {
        Ok(()) => std::fs::rename(&temp, target).map_err(|e| {
            // The bytes are written but couldn't be moved into place — drop the temp so it doesn't
            // linger, and report the failure.
            let _ = std::fs::remove_file(&temp);
            format!("could not finalize file: {e}")
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// Prompt for a destination and stream an attachment to it. Returns the saved absolute path (for a
/// "Saved to …" toast), or `Ok(None)` when the user cancels the dialog (a silent no-op). Runs the
/// blocking dialog + HTTP + file I/O off the async runtime.
fn save_attachment_inner(
    app: &AppHandle,
    provider_id: &str,
    download_url: &str,
    suggested_name: &str,
) -> Result<Option<String>, String> {
    // Pin the (frontend-supplied) URL to the provider origin BEFORE attaching the bearer token, so
    // a compromised webview can't point the download at an attacker host and exfiltrate the token.
    ensure_provider_origin(provider_id, download_url)?;

    // Native Save dialog — the user picks the exact destination (and confirms any overwrite), so
    // there is no silent rename-on-conflict and the app learns the real final path.
    let Some(file_path) = app
        .dialog()
        .file()
        .set_file_name(safe_file_name(suggested_name))
        .blocking_save_file()
    else {
        return Ok(None); // cancelled
    };
    let target = file_path.into_path().map_err(|e| e.to_string())?;

    let client = download_client(download_url)?;
    let mut resp = fetch_authenticated(&client, download_url, provider_id)?;
    stream_to_file(&mut resp, &target)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Save an email attachment to a user-chosen path on desktop (native dialog + streamed write).
/// Returns the saved absolute path, or `null` when the user cancelled the dialog. The frontend
/// builds `download_url` from the JMAP session; this command attaches the keychain bearer token.
#[tauri::command]
pub async fn save_attachment(
    app: AppHandle,
    provider_id: String,
    download_url: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        save_attachment_inner(&app, &provider_id, &download_url, &suggested_name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_directory_traversal_to_the_bare_name() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(
            safe_file_name("..\\..\\windows\\system32\\evil.dll"),
            "evil.dll"
        );
        assert_eq!(safe_file_name("/absolute/path/report.pdf"), "report.pdf");
        // A Windows drive prefix's `:` is in the reserved set, and the path components are stripped.
        assert_eq!(safe_file_name("C:\\Users\\bob\\secret.txt"), "secret.txt");
    }

    #[test]
    fn strips_control_and_reserved_characters() {
        assert_eq!(safe_file_name("a:b*c?d\"e<f>g|h.txt"), "abcdefgh.txt");
        assert_eq!(safe_file_name("re\u{0000}port\u{0007}.pdf"), "report.pdf");
    }

    #[test]
    fn falls_back_when_nothing_usable_remains() {
        assert_eq!(safe_file_name(""), "attachment");
        assert_eq!(safe_file_name("."), "attachment");
        assert_eq!(safe_file_name(".."), "attachment");
        assert_eq!(safe_file_name("/"), "attachment");
        assert_eq!(safe_file_name("..."), "attachment"); // trailing dots trimmed → empty
        assert_eq!(safe_file_name("   "), "attachment");
    }

    #[test]
    fn keeps_ordinary_names_and_leading_dots() {
        assert_eq!(safe_file_name("report.pdf"), "report.pdf");
        assert_eq!(
            safe_file_name("my notes (final).docx"),
            "my notes (final).docx"
        );
        // A leading dot is a legitimate (hidden-style) name, not a traversal.
        assert_eq!(safe_file_name(".env.example"), ".env.example");
    }

    #[test]
    fn trims_trailing_dots_and_spaces() {
        // Windows would trim these on write; do it up front so the default matches the saved name.
        assert_eq!(safe_file_name("report.pdf.  "), "report.pdf");
        assert_eq!(safe_file_name("name."), "name");
    }

    #[test]
    fn caps_the_length() {
        let long = "a".repeat(500);
        assert_eq!(safe_file_name(&long).chars().count(), MAX_NAME_LEN);
    }
}
