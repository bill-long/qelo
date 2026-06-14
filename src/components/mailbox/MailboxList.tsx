import { createMemo, For, Show } from "solid-js";
import {
  canDropOnMailbox,
  draggingEmailId,
  dropTargetMailboxId,
  endDrag,
  setDropTargetMailboxId,
} from "@/stores/drag";
import { moveEmails, threadList } from "@/stores/emails";
import { buildMailboxTree, type MailboxNode, mailboxes } from "@/stores/mailboxes";
import { selectedMailboxId, setSelectedMailboxId } from "@/stores/ui";

export function MailboxList() {
  const tree = createMemo(() => buildMailboxTree(Object.values(mailboxes)));
  return (
    <nav class="mailbox-list">
      <For each={tree()}>{(node) => <MailboxRow node={node} depth={0} />}</For>
    </nav>
  );
}

function MailboxRow(props: { node: MailboxNode; depth: number }) {
  const mailbox = () => props.node.mailbox;
  const isSelected = () => selectedMailboxId() === mailbox().id;
  // This row is the lit drop target when the shared signal names it (set on a valid dragover,
  // cleared on a real dragleave / drop / dragend). A single shared signal keeps the highlight
  // exclusive and never stale — see dropTargetMailboxId.
  const isDropTarget = () => dropTargetMailboxId() === mailbox().id;

  // Bound to both dragenter and dragover: preventDefault on each is what marks this row a valid
  // drop target (the spec wants both; WebView2/WKWebView accept dragover-only, but enter is cheap
  // insurance), withholding it (the disallowed case — wrong rights, or this is the source folder)
  // leaves the browser's not-allowed cursor as the cue. Re-checked live so a folder switch / rights
  // revision mid-drag is honored. dataTransfer can be null on synthetic events.
  function onDragOver(event: DragEvent) {
    if (draggingEmailId() === null || !canDropOnMailbox(mailbox())) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setDropTargetMailboxId(mailbox().id);
  }

  function onDragLeave(event: DragEvent) {
    // dragleave also fires when the pointer crosses onto a child element (the name/unread
    // spans); ignore those so the highlight doesn't flicker — only clear on a real exit. Clear
    // only if WE are still the lit target: when moving straight onto an adjacent row, its
    // dragover may have already claimed the signal, and we must not wipe its highlight.
    const related = event.relatedTarget as Node | null;
    const row = event.currentTarget as HTMLElement | null;
    if (related && row?.contains(related)) return;
    if (dropTargetMailboxId() === mailbox().id) setDropTargetMailboxId(null);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    const id = draggingEmailId();
    endDrag();
    const target = mailbox();
    // Re-validate the captured drag against live state before dispatching (stale-snapshot guard,
    // qelo-review-checklist): the drag captured the representative id at dragstart, but a coalesced
    // syncThreadList may have moved/removed that row, switched the open folder, or rights may have
    // been revised in the interim. Bail unless the drop is still permitted AND the dragged
    // representative is still shown in the open folder; moveEmails then owns the optimistic move +
    // server reconcile from the (live) open folder it reads as threadList.mailboxId.
    if (id === null || !canDropOnMailbox(target) || !threadList.ids.includes(id)) return;
    void moveEmails([id], target.id);
  }

  return (
    <>
      <button
        type="button"
        class="mailbox-row"
        classList={{ "is-selected": isSelected(), "is-drop-target": isDropTarget() }}
        data-role={mailbox().role ?? undefined}
        style={{ "padding-left": `${0.75 + props.depth * 0.85}rem` }}
        onClick={() => setSelectedMailboxId(mailbox().id)}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span class="mailbox-name">{mailbox().name}</span>
        <Show when={mailbox().unreadEmails > 0}>
          <span class="mailbox-unread">{mailbox().unreadEmails}</span>
        </Show>
      </button>
      <For each={props.node.children}>
        {(child) => <MailboxRow node={child} depth={props.depth + 1} />}
      </For>
    </>
  );
}
