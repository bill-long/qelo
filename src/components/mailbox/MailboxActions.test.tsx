import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { MailboxActions } from "@/components/mailbox/MailboxActions";
import type { Mailbox, MailboxRights } from "@/jmap/types";
import { moveConversation, moveEmails } from "@/stores/emails";
import { setMailboxes } from "@/stores/mailboxes";
import { setSelectedMailboxId } from "@/stores/ui";

// Mock only the move writes (they expand the thread / read threadList + hit the network); every
// other store export stays real (none is invoked at render).
vi.mock("@/stores/emails", async (importActual) => {
  const actual = await importActual<typeof import("@/stores/emails")>();
  return {
    ...actual,
    moveConversation: vi.fn(async () => {}),
    moveEmails: vi.fn(async () => {}),
  };
});
const moveConversationMock = moveConversation as unknown as Mock;
const moveEmailsMock = moveEmails as unknown as Mock;

function rights(partial: Partial<MailboxRights>): MailboxRights {
  return {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: false,
    mayRename: false,
    mayDelete: false,
    maySubmit: false,
    ...partial,
  };
}

function mailbox(partial: Partial<Mailbox>): Mailbox {
  return {
    id: "m",
    name: "Folder",
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: rights({}),
    isSubscribed: true,
    ...partial,
  };
}

// Inbox (open, removable) + dedicated archive/trash roles + a generic destination + a read-only
// folder that rejects items. The picker should offer ONLY "Projects".
function seedFolders(inboxRights?: Partial<MailboxRights>) {
  setMailboxes(
    reconcile({
      inbox: mailbox({
        id: "inbox",
        name: "Inbox",
        role: "inbox",
        myRights: rights(inboxRights ?? {}),
      }),
      archive: mailbox({ id: "archive", name: "Archive", role: "archive" }),
      trash: mailbox({ id: "trash", name: "Trash", role: "trash" }),
      projects: mailbox({ id: "projects", name: "Projects" }),
      readonly: mailbox({
        id: "readonly",
        name: "Locked",
        myRights: rights({ mayAddItems: false }),
      }),
    }),
  );
  setSelectedMailboxId("inbox");
}

afterEach(() => {
  cleanup();
  setMailboxes(reconcile({}));
  setSelectedMailboxId(null);
  moveConversationMock.mockClear();
  moveEmailsMock.mockClear();
});

describe("MailboxActions row variant — keyboard move to an arbitrary folder", () => {
  it("offers a keyboard-reachable picker of non-dedicated destinations", () => {
    seedFolders();
    render(() => <MailboxActions variant="row" repId={() => "rep1"} />);

    // A native <select> = a combobox, so it's keyboard/AT reachable (the a11y twin of drag-and-drop).
    const picker = screen.getByRole("combobox", { name: /move conversation to folder/i });
    const options = [...picker.querySelectorAll("option")].map((o) => o.textContent);
    // A plain-text "Move" placeholder (not an emoji, so it's announced as a real word) + only the
    // generic destination: archive/trash have their own buttons, the read-only folder rejects items,
    // and the open folder itself can't be a self-move target.
    expect(options).toEqual(["Move", "Projects"]);
  });

  it("moves the whole conversation to the picked folder, then resets to the placeholder", () => {
    seedFolders();
    render(() => <MailboxActions variant="row" repId={() => "rep1"} />);
    const picker = screen.getByRole("combobox", {
      name: /move conversation to folder/i,
    }) as HTMLSelectElement;

    fireEvent.change(picker, { target: { value: "projects" } });

    expect(moveConversationMock).toHaveBeenCalledWith("rep1", "projects");
    // Reset so the same destination can be chosen again later (the row stays put until sync prunes it).
    expect(picker.selectedIndex).toBe(0);
  });

  it("hides the picker when the open folder can't have items removed", () => {
    // No mayRemoveItems on the source ⇒ canMoveInto is false for every target ⇒ no destinations.
    seedFolders({ mayRemoveItems: false });
    render(() => <MailboxActions variant="row" repId={() => "rep1"} />);

    expect(screen.queryByRole("combobox", { name: /move conversation to folder/i })).toBeNull();
    expect(moveConversationMock).not.toHaveBeenCalled();
  });
});

describe("MailboxActions message variant — the shared picker still dispatches per-message", () => {
  it("keeps the 'Move to…' label and moves the given messages (not the conversation)", () => {
    // The picker markup/onChange is shared across variants; this locks the message branch so a
    // future row-variant edit can't regress the reading-pane dispatch or its placeholder text.
    seedFolders();
    render(() => <MailboxActions variant="message" ids={() => ["m1", "m2"]} />);

    const picker = screen.getByRole("combobox", { name: /^move to folder$/i });
    expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Move to…",
      "Projects",
    ]);

    fireEvent.change(picker, { target: { value: "projects" } });

    expect(moveEmailsMock).toHaveBeenCalledWith(["m1", "m2"], "projects");
    expect(moveConversationMock).not.toHaveBeenCalled();
  });
});
