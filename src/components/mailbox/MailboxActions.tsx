import { For, Show } from "solid-js";
import { archive, deleteForever, moveEmails, trash } from "@/stores/emails";
import {
  mailboxes,
  moveTargetByRole,
  selectedMailboxRights,
  selectedMailboxRole,
} from "@/stores/mailboxes";
import { selectedMailboxId } from "@/stores/ui";

/**
 * Move / archive / trash / delete affordances for one or more emails, shared by the reading
 * pane (`variant="message"`, labelled buttons) and a conversation row (`variant="row"`,
 * icon-only). `ids` is an accessor so the set is read at click time, never captured stale.
 *
 * Every affordance is myRights-gated (CLAUDE.md / D2): archive and trash need `mayRemoveItems`
 * on the open folder AND a role target that grants `mayAddItems` (resolved by
 * `moveTargetByRole`); "delete forever" is a hard destroy offered only from within Trash, gated
 * on `mayDelete`. The store actions are the real enforcement (server `notUpdated`/`notDestroyed`);
 * these gates just avoid offering an action the server would reject.
 */
export function MailboxActions(props: { ids: () => string[]; variant: "message" | "row" }) {
  const rights = () => selectedMailboxRights();
  const canRemove = () => Boolean(rights()?.mayRemoveItems);
  const archiveTarget = () => moveTargetByRole("archive");
  const trashTarget = () => moveTargetByRole("trash");
  const canDeleteForever = () => selectedMailboxRole() === "trash" && Boolean(rights()?.mayDelete);

  // Every other mailbox that accepts items, for the generic move picker (reading pane only).
  const moveTargets = () => {
    const current = selectedMailboxId();
    return Object.values(mailboxes)
      .filter((m) => m.id !== current && m.myRights.mayAddItems)
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
            if (to) void moveEmails(props.ids(), to);
          }}
        >
          <option value="">Move to…</option>
          <For each={moveTargets()}>{(m) => <option value={m.id}>{m.name}</option>}</For>
        </select>
      </Show>

      <Show when={canRemove() && archiveTarget()}>
        <ActionButton
          variant={props.variant}
          icon="🗄"
          label="Archive"
          onClick={() => void archive(props.ids())}
        />
      </Show>

      <Show when={canRemove() && trashTarget()}>
        <ActionButton
          variant={props.variant}
          icon="🗑"
          label="Trash"
          onClick={() => void trash(props.ids())}
        />
      </Show>

      <Show when={canDeleteForever()}>
        <ActionButton
          variant={props.variant}
          icon="✕"
          label="Delete forever"
          danger
          onClick={() => void deleteForever(props.ids())}
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
