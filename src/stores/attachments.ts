// Download an existing message attachment to the user's machine.
//
// The blob download endpoint requires the JMAP bearer header, so a plain <a href> pointed at the
// downloadUrl wouldn't authenticate (and the email iframe is sandboxed anyway). Instead we fetch
// the bytes through the authenticated client (JmapClient.download → Blob) and then save that Blob
// via a transient object-URL download anchor — the same mechanism for the desktop webview
// (WebView2/WKWebView honor a `download` anchor) and the browser/PWA build. A native Tauri
// save-dialog on desktop is a possible later refinement; it isn't worth a new Rust capability here.
//
// Living in the store layer (like open-external.ts) keeps the transport call + DOM save out of the
// pure jmap/ and lib/ layers, and lets the reading pane dispatch a store action rather than reach
// for JmapClient directly. Per-blobId in-flight + error state lets each attachment row reflect its
// own download independently.

import { createSignal } from "solid-js";
import type { EmailBodyPart } from "@/jmap/types";
import { handleAuthFailure, jmap } from "./account";

const [downloading, setDownloading] = createSignal<ReadonlySet<string>>(new Set());
const [errors, setErrors] = createSignal<Record<string, string>>({});

/** True while the attachment with this blobId is being fetched (gates + labels its button). */
export function isDownloading(blobId: string): boolean {
  return downloading().has(blobId);
}

/** The last download error for this blobId, or undefined — surfaced beside its row. */
export function downloadErrorFor(blobId: string): string | undefined {
  return errors()[blobId];
}

function startDownload(blobId: string): void {
  setDownloading((prev) => new Set(prev).add(blobId));
  // Clear any prior error for this blob so a retry doesn't show a stale message.
  setErrors((prev) => {
    if (!(blobId in prev)) return prev;
    const { [blobId]: _removed, ...rest } = prev;
    return rest;
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
 * one already downloading. Fetches the bytes through the authenticated client, then saves the Blob;
 * an auth failure raises the global re-auth gate, any other error is surfaced for the row via
 * {@link downloadErrorFor}. Never rejects.
 */
export async function downloadAttachment(part: EmailBodyPart): Promise<void> {
  const blobId = part.blobId;
  if (!blobId || downloading().has(blobId)) return;
  const name = part.name ?? "attachment";
  const type = part.type || "application/octet-stream";
  startDownload(blobId);
  try {
    const blob = await jmap().download(blobId, type, name);
    saveBlob(blob, name);
  } catch (err) {
    if (handleAuthFailure(err)) return;
    setErrors((prev) => ({ ...prev, [blobId]: err instanceof Error ? err.message : String(err) }));
  } finally {
    endDownload(blobId);
  }
}
