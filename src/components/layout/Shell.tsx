import { MailboxList } from "@/components/mailbox/MailboxList";
import { ThreadList } from "@/components/thread-list/ThreadList";
import { ThreadView } from "@/components/thread-view/ThreadView";

/** The three-pane mail layout: folders | conversation list | reading pane. */
export function Shell() {
  return (
    <div class="shell">
      <nav class="shell-folders">
        <div class="brand">Qelo</div>
        <MailboxList />
      </nav>
      <section class="shell-threads">
        <ThreadList />
      </section>
      <section class="shell-view">
        <ThreadView />
      </section>
    </div>
  );
}
