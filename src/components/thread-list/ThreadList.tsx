import { createEffect, For, Show } from "solid-js";
import { MailboxActions } from "@/components/mailbox/MailboxActions";
import { formatDate, senderName } from "@/lib/format";
import { draggingEmailId, endDrag, setDraggingEmailId } from "@/stores/drag";
import { emails, loadMore, markSeen, openMailbox, setFlagged, threadList } from "@/stores/emails";
import { selectedMailboxRights } from "@/stores/mailboxes";
import {
  selectedEmailId,
  selectedMailboxId,
  setSelectedEmailId,
  setSelectedThreadId,
} from "@/stores/ui";

export function ThreadList() {
  // Load (or reload) whenever the selected folder changes.
  createEffect(() => {
    const id = selectedMailboxId();
    if (id) void openMailbox(id);
  });

  function onScroll(event: Event) {
    const el = event.currentTarget as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) void loadMore();
  }

  function retryOpen() {
    const id = selectedMailboxId();
    if (id) void openMailbox(id);
  }

  return (
    // dragend is handled here on the stable container, not on the row, because drag events
    // bubble and a row can unmount mid-drag (a coalesced sync pruning the dragged id) — a
    // handler on the row would then never fire, stranding draggingEmailId non-null. The
    // container outlives any single row, so endDrag reliably clears the drag state (source-fade +
    // drop-target highlight) on drop / Escape / drop-outside, even if the dragged row unmounted.
    // biome-ignore lint/a11y/noStaticElementInteractions: dragend here is drag-state cleanup, not an interaction affordance
    <div class="thread-list" onScroll={onScroll} onDragEnd={endDrag}>
      <Show when={selectedMailboxId()} fallback={<p class="thread-list-note">Select a folder</p>}>
        <Show
          when={!threadList.error}
          fallback={
            <div class="thread-list-note">
              <p class="thread-list-error">{threadList.error}</p>
              <button type="button" onClick={retryOpen}>
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={threadList.ids.length > 0}
            fallback={
              <p class="thread-list-note">{threadList.loading ? "Loading…" : "No messages"}</p>
            }
          >
            <For each={threadList.ids}>{(id) => <ThreadRow id={id} />}</For>
            <Show when={threadList.loading}>
              <p class="thread-list-note">Loading more…</p>
            </Show>
            <Show when={threadList.loadMoreError && !threadList.loading}>
              <div class="thread-list-note">
                <span class="thread-list-error">Couldn't load more.</span>{" "}
                <button type="button" onClick={() => void loadMore()}>
                  Retry
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function ThreadRow(props: { id: string }) {
  const email = () => emails[props.id];
  const isSelected = () => selectedEmailId() === props.id;
  const rights = () => selectedMailboxRights();
  const seen = () => Boolean(email()?.keywords.$seen);
  const flagged = () => Boolean(email()?.keywords.$flagged);

  return (
    <Show when={email()}>
      {(mail) => (
        // Drag-to-move is a deliberately pointer-only convenience (HTML5 DnD has no keyboard/AT
        // equivalent). It adds NO capability — the accessible route to the same outcome is
        // unchanged: archive/trash on the row, and for an arbitrary folder the reading-pane
        // "Move to…" picker (open the conversation — keyboard-reachable — then MailboxActions'
        // message variant). dragend is bound on the .thread-list container, not here.
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only DnD; the reading-pane "Move to…" picker is the a11y path
        <div
          class="thread-row"
          classList={{
            "is-selected": isSelected(),
            "is-unread": !seen(),
            "is-dragging": draggingEmailId() === mail().id,
          }}
          // Only offered when the open folder grants mayRemoveItems — the same right canMoveInto
          // gates on; the drop re-checks it and the target live via canDropOnMailbox.
          draggable={Boolean(rights()?.mayRemoveItems)}
          onDragStart={(event) => {
            setDraggingEmailId(mail().id);
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = "move";
              // Firefox refuses to start a drag unless some data is set; the move reads the id
              // back from the draggingEmailId signal, not this payload.
              event.dataTransfer.setData("text/plain", mail().id);
            }
          }}
        >
          <button
            type="button"
            class="thread-row-main"
            onClick={() => {
              setSelectedEmailId(mail().id);
              setSelectedThreadId(mail().threadId);
            }}
          >
            <div class="thread-row-head">
              <span class="thread-sender">{senderName(mail().from)}</span>
              <span class="thread-date">{formatDate(mail().receivedAt)}</span>
            </div>
            <div class="thread-subject">
              <Show when={flagged()}>
                <span class="thread-flag" role="img" aria-label="Flagged">
                  ⚑
                </span>
              </Show>
              <span class="thread-subject-text">{mail().subject || "(no subject)"}</span>
              <Show when={mail().hasAttachment}>
                <span class="thread-attach" role="img" aria-label="Has attachment">
                  📎
                </span>
              </Show>
            </div>
            <div class="thread-preview">{mail().preview}</div>
          </button>
          <div class="thread-row-actions">
            <Show when={rights()?.maySetKeywords}>
              <button
                type="button"
                class="row-action"
                aria-pressed={flagged()}
                title={flagged() ? "Remove flag" : "Flag"}
                aria-label={flagged() ? "Remove flag" : "Flag"}
                onClick={() => void setFlagged([mail().id], !flagged())}
              >
                ⚑
              </button>
            </Show>
            <Show when={rights()?.maySetSeen}>
              <button
                type="button"
                class="row-action"
                aria-pressed={seen()}
                title={seen() ? "Mark unread" : "Mark read"}
                aria-label={seen() ? "Mark unread" : "Mark read"}
                onClick={() => void markSeen([mail().id], !seen())}
              >
                {seen() ? "○" : "●"}
              </button>
            </Show>
            <MailboxActions ids={() => [mail().id]} variant="row" />
          </div>
        </div>
      )}
    </Show>
  );
}
