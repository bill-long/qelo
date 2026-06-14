import { createSignal } from "solid-js";
import type { Mailbox } from "@/jmap/types";
import { threadList } from "./emails";
import { canMoveInto } from "./mailboxes";

/**
 * The representative email id of the thread row currently being dragged, or null when no drag is
 * in progress. Pure UI interaction state for the folder drag-and-drop affordance — a pointer-only
 * convenience (HTML5 DnD has no robust AT story); the accessible route to the same outcome is
 * unchanged (row archive/trash, and the reading-pane "Move to…" picker). `dataTransfer` can't be
 * read during `dragover`, so the hover gating/highlight needs the id in a signal the MailboxList
 * reads while the pointer is over a folder; `drop` re-reads it from here too (not `dataTransfer`).
 */
export const [draggingEmailId, setDraggingEmailId] = createSignal<string | null>(null);

/**
 * The id of the mailbox the pointer is currently over as a valid drop target during a drag (or
 * null). A single shared signal — not per-row local state — so the highlight is naturally
 * exclusive (only one folder lit) and, crucially, can't go stale: {@link endDrag} clears it when
 * the drag ends, so a folder can't stay lit after an Escape-cancel that skips the target's final
 * `dragleave` (WebView2/WKWebView don't reliably deliver it) and then re-light under a later drag.
 */
export const [dropTargetMailboxId, setDropTargetMailboxId] = createSignal<string | null>(null);

/**
 * Clear all drag state. Bound to `dragend` on the stable thread-list container (drag events
 * bubble, and the dragged row may unmount mid-drag), so both the source-fade and the drop-target
 * highlight always reset once the drag ends — by drop, Escape, or release outside any folder.
 */
export function endDrag(): void {
  setDraggingEmailId(null);
  setDropTargetMailboxId(null);
}

/**
 * Whether the dragged thread may be dropped onto `target`: the OPEN folder is the move's
 * from-mailbox (`moveEmails` reads it as `threadList.mailboxId`), so this defers to the shared
 * {@link canMoveInto} predicate the "Move to…" picker also uses. Read live off the stores — never
 * captured at dragstart — so a rights revision or folder change mid-drag is respected, and so the
 * hover highlight stays reactive.
 */
export function canDropOnMailbox(target: Mailbox): boolean {
  const sourceId = threadList.mailboxId;
  return sourceId !== null && canMoveInto(target, sourceId);
}
