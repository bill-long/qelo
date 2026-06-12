import { createMemo, For, Show } from "solid-js";
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
  return (
    <>
      <button
        type="button"
        class="mailbox-row"
        classList={{ "is-selected": isSelected() }}
        data-role={mailbox().role ?? undefined}
        style={{ "padding-left": `${0.75 + props.depth * 0.85}rem` }}
        onClick={() => setSelectedMailboxId(mailbox().id)}
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
