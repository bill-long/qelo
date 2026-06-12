import { MailboxList } from "@/components/mailbox/MailboxList";
import { ThreadList } from "@/components/thread-list/ThreadList";
import { ThreadView } from "@/components/thread-view/ThreadView";
import { SyncStatus } from "./SyncStatus";

/** The three-pane mail layout: folders | conversation list | reading pane. */
export function Shell() {
  return (
    <div class="shell">
      {/* The folder sidebar is an <aside>; MailboxList provides the inner <nav>
          landmark, so nesting two navigation regions is avoided. */}
      <aside class="shell-folders">
        <div class="brand">Qelo</div>
        <MailboxList />
        <SyncStatus />
      </aside>
      <section class="shell-threads">
        <ThreadList />
      </section>
      <section class="shell-view">
        <ThreadView />
      </section>
    </div>
  );
}
