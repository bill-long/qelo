// Download an existing message attachment to the user's machine.
//
// The blob download endpoint requires the JMAP bearer header, so a plain <a href> pointed at the
// downloadUrl wouldn't authenticate (and the email iframe is sandboxed anyway). The save path
// diverges by build target:
//
//   - Desktop: the Rust `save_attachment` command opens a native Save dialog, fetches the blob with
//     the keychain bearer token, and streams it straight to the chosen path — so the user picks the
//     destination, there's no silent rename-on-conflict, and we get the real final path for a
//     "Saved to …" toast. The frontend only builds the download URL (the bearer header is attached
//     Rust-side, not embedded in the URL); the bytes never pass through JS. See
//     src-tauri/src/download.rs.
//   - Browser/PWA: no native dialog, so fetch the bytes through the authenticated client
//     (JmapClient.download → Blob) and save via a transient object-URL <a download> anchor. The
//     browser owns the download location and UI here.
//
// Living in the store layer (like open-external.ts) keeps the transport call + DOM save out of the
// pure jmap/ and lib/ layers, and lets the reading pane dispatch a store action rather than reach
// for JmapClient directly. Per-blobId in-flight + error state lets each attachment row reflect its
// own download independently.

import { invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import type { EmailBodyPart } from "@/jmap/types";
import { handleAuthFailure, isDesktop, jmap, PROVIDER_ID } from "./account";
import { notify } from "./toasts";

// Keyed by blobId (a server-supplied string). Both use real collections rather than a plain object
// so an exotic key (e.g. "__proto__") is just an ordinary entry — no prototype-pollution footgun.
const [downloading, setDownloading] = createSignal<ReadonlySet<string>>(new Set());
const [errors, setErrors] = createSignal<ReadonlyMap<string, string>>(new Map());

/** True while the attachment with this blobId is being fetched (gates + labels its button). */
export function isDownloading(blobId: string): boolean {
  return downloading().has(blobId);
}

/** The last download error for this blobId, or undefined — surfaced beside its row. */
export function downloadErrorFor(blobId: string): string | undefined {
  return errors().get(blobId);
}

function startDownload(blobId: string): void {
  setDownloading((prev) => new Set(prev).add(blobId));
  // Clear any prior error for this blob so a retry doesn't show a stale message.
  setErrors((prev) => {
    if (!prev.has(blobId)) return prev;
    const next = new Map(prev);
    next.delete(blobId);
    return next;
  });
}

function endDownload(blobId: string): void {
  setDownloading((prev) => {
    const next = new Set(prev);
    next.delete(blobId);
    return next;
  });
}

// Hold the object URL alive briefly after the click so an engine that reads the blob asynchronously
// when starting the download (notably WebKit/WKWebView, the macOS desktop webview) still has a valid
// URL; revoking synchronously can truncate or abort a large save. A short delay frees the blob soon
// after without pinning it indefinitely.
const REVOKE_DELAY_MS = 10_000;

/**
 * Save a fetched Blob to disk via a transient download anchor, then free the object URL after a
 * short delay (see {@link REVOKE_DELAY_MS}) so the blob isn't pinned in memory.
 */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/**
 * Download one attachment and save it. No-op for a part without a `blobId` (it can't be fetched) or
 * one already downloading. On desktop, the Rust backend prompts for a destination and streams the
 * blob there (a cancelled dialog is a silent no-op, a successful save shows a "Saved to …" toast);
 * in the browser/PWA build, the bytes are fetched here and saved via a download anchor. An auth
 * failure on the browser path raises the global re-auth gate; any other error is surfaced for the
 * row via {@link downloadErrorFor}. Never rejects.
 */
export async function downloadAttachment(part: EmailBodyPart): Promise<void> {
  const blobId = part.blobId;
  if (!blobId || downloading().has(blobId)) return;
  const name = part.name ?? "attachment";
  const type = part.type || "application/octet-stream";
  startDownload(blobId);
  try {
    if (isDesktop) {
      // The bytes never enter JS: Rust fetches the URL (built here) with the keychain bearer token
      // and streams it to the user's chosen path. `null` => the user cancelled the Save dialog.
      const savedPath = await invoke<string | null>("save_attachment", {
        providerId: PROVIDER_ID,
        downloadUrl: jmap().downloadUrlFor(blobId, type, name),
        suggestedName: name,
      });
      if (savedPath) notify(`Saved to ${savedPath}`);
    } else {
      const blob = await jmap().download(blobId, type, name);
      saveBlob(blob, name);
    }
  } catch (err) {
    if (handleAuthFailure(err)) return;
    const message = err instanceof Error ? err.message : String(err);
    setErrors((prev) => new Map(prev).set(blobId, message));
  } finally {
    endDownload(blobId);
  }
}
