import { For, Show } from "solid-js";
import {
  archive,
  archiveConversation,
  deleteConversationForever,
  deleteForever,
  moveEmails,
  trash,
  trashConversation,
} from "@/stores/emails";
import {
  canMoveInto,
  mailboxes,
  moveTargetByRole,
  selectedMailboxRights,
  selectedMailboxRole,
} from "@/stores/mailboxes";
import { selectedMailboxId } from "@/stores/ui";

/**
 * Move / archive / trash / delete affordances, shared by the reading pane (`variant="message"`,
 * labelled buttons) and a collapsed conversation row (`variant="row"`, icon-only).
 *
 * The two variants differ in SCOPE, not just looks. The reading pane acts per-message, so it takes
 * an `ids` accessor (read at click time, never captured stale) and calls the id-set actions. A row
 * acts on the whole CONVERSATION, so it takes the row's representative id (`repId`) and calls the
 * conversation actions, which expand it to the thread and scope the move/destroy to the open folder
 * (matching OWA/Gmail/Apple Mail — see emails.ts). The generic "Move to…" picker is reading-pane
 * only; a row reaches an arbitrary folder via drag-and-drop.
 *
 * Every affordance is myRights-gated (CLAUDE.md / D2): archive and trash need `mayRemoveItems` on
 * the open folder AND a role target that grants `mayAddItems` (resolved by `moveTargetByRole`);
 * "delete forever" is a hard destroy offered only from within Trash, gated on `mayRemoveItems` (the
 * right that governs removing/destroying an email). The store actions are the real enforcement
 * (server `notUpdated`/`notDestroyed`); these gates just avoid offering an action the server rejects.
 */
type MailboxActionsProps =
  | { variant: "message"; ids: () => string[] }
  | { variant: "row"; repId: () => string };

export function MailboxActions(props: MailboxActionsProps) {
  // Dispatch the per-message id-set action (reading pane) or its whole-conversation equivalent
  // (row), keyed off the discriminated variant. Conversation actions take the row's representative.
  const onArchive = () =>
    props.variant === "row" ? void archiveConversation(props.repId()) : void archive(props.ids());
  const onTrash = () =>
    props.variant === "row" ? void trashConversation(props.repId()) : void trash(props.ids());
  const onDeleteForever = () =>
    props.variant === "row"
      ? void deleteConversationForever(props.repId())
      : void deleteForever(props.ids());

  const rights = () => selectedMailboxRights();
  const canRemove = () => Boolean(rights()?.mayRemoveItems);
  const archiveTarget = () => moveTargetByRole("archive");
  const trashTarget = () => moveTargetByRole("trash");
  // A hard destroy removes the email from its mailbox(es), so the governing right is
  // `mayRemoveItems` (RFC 8621) — NOT `mayDelete`, which is the right to delete the mailbox
  // itself. Offered only from within Trash (D2).
  const canDeleteForever = () => selectedMailboxRole() === "trash" && canRemove();

  // Every other mailbox that accepts items, for the generic move picker (reading pane only) —
  // minus the archive/trash roles that already have their own dedicated buttons beside it, so a
  // destination is never offered twice.
  const moveTargets = () => {
    const current = selectedMailboxId();
    if (!current) return [];
    const dedicated = new Set([archiveTarget(), trashTarget()].filter(Boolean));
    return Object.values(mailboxes)
      .filter((m) => canMoveInto(m, current) && !dedicated.has(m.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  return (
    <>
      <Show when={props.variant === "message" && canRemove() && moveTargets().length > 0}>
        <select
          class="message-action message-move"
          aria-label="Move to folder"
          onChange={(event) => {
            const to = event.currentTarget.value;
            // Reset to the placeholder so the same destination can be chosen again later.
            event.currentTarget.selectedIndex = 0;
            // The picker is message-variant only (guarded by the enclosing Show), so `ids` exists.
            if (to && props.variant === "message") void moveEmails(props.ids(), to);
          }}
        >
          <option value="">Move to…</option>
          <For each={moveTargets()}>{(m) => <option value={m.id}>{m.name}</option>}</For>
        </select>
      </Show>

      <Show when={canRemove() && archiveTarget()}>
        <ActionButton variant={props.variant} icon="🗄" label="Archive" onClick={onArchive} />
      </Show>

      <Show when={canRemove() && trashTarget()}>
        <ActionButton variant={props.variant} icon="🗑" label="Trash" onClick={onTrash} />
      </Show>

      <Show when={canDeleteForever()}>
        <ActionButton
          variant={props.variant}
          icon="✕"
          label="Delete forever"
          danger
          onClick={onDeleteForever}
        />
      </Show>
    </>
  );
}

/**
 * One action button styled to match the variant's existing controls: the reading pane shows the
 * icon + label, a row shows the icon alone (the label rides on `aria-label`/`title` for a11y).
 */
function ActionButton(props: {
  variant: "message" | "row";
  icon: string;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  const cls = () => {
    const base = props.variant === "message" ? "message-action" : "row-action";
    return props.danger ? `${base} is-danger` : base;
  };
  return (
    <button
      type="button"
      class={cls()}
      title={props.label}
      aria-label={props.label}
      onClick={() => props.onClick()}
    >
      <span aria-hidden="true">{props.icon}</span>
      <Show when={props.variant === "message"}>
        <span>{props.label}</span>
      </Show>
    </button>
  );
}
