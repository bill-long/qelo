import { createEffect, createMemo, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { selectBody } from "@/lib/body";
import { formatBytes, formatDateTime, recipientList, senderName } from "@/lib/format";
import { emailSrcdoc, sanitizeHtml } from "@/lib/sanitize";
import { prefersDark } from "@/lib/theme";
import { emails, loadThread, markSeen, setFlagged, thread } from "@/stores/emails";
import { selectedMailboxRights } from "@/stores/mailboxes";
import { openExternal } from "@/stores/open-external";
import { selectedEmailId, selectedThreadId } from "@/stores/ui";

export function ThreadView() {
  function load() {
    const id = selectedThreadId();
    if (id) void loadThread(id);
  }

  createEffect(load);

  return (
    <div class="thread-view">
      <Show
        when={selectedThreadId()}
        fallback={<p class="thread-view-note">No conversation selected</p>}
      >
        <Show
          when={!thread.error}
          fallback={
            <div class="thread-view-note">
              <p class="thread-view-error">{thread.error}</p>
              <button type="button" onClick={load}>
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={thread.emailIds.length > 0}
            fallback={<p class="thread-view-note">{thread.loading ? "Loading…" : "Empty"}</p>}
          >
            <For each={thread.emailIds}>{(id) => <Message id={id} />}</For>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function Message(props: { id: string }) {
  let el: HTMLElement | undefined;
  const isSelected = () => selectedEmailId() === props.id;
  // Bring the clicked message into view when a multi-message thread opens.
  onMount(() => {
    if (isSelected()) el?.scrollIntoView({ block: "nearest" });
  });

  const rights = () => selectedMailboxRights();

  return (
    <Show when={emails[props.id]}>
      {(mail) => {
        const body = () => selectBody(mail());
        const attachments = () => mail().attachments ?? [];
        const seen = () => Boolean(mail().keywords.$seen);
        const flagged = () => Boolean(mail().keywords.$flagged);
        return (
          <article ref={el} class="message" classList={{ "is-selected": isSelected() }}>
            <header class="message-head">
              <span class="message-from">{senderName(mail().from)}</span>
              <span class="message-date">{formatDateTime(mail().receivedAt)}</span>
              <Show when={recipientList(mail().to)}>
                {(to) => <span class="message-to">to {to()}</span>}
              </Show>
              <h2 class="message-subject">{mail().subject || "(no subject)"}</h2>
              <Show when={rights()?.maySetSeen || rights()?.maySetKeywords}>
                <div class="message-actions">
                  <Show when={rights()?.maySetKeywords}>
                    <button
                      type="button"
                      class="message-action"
                      aria-pressed={flagged()}
                      onClick={() => void setFlagged([mail().id], !flagged())}
                    >
                      <span aria-hidden="true">⚑</span> {flagged() ? "Flagged" : "Flag"}
                    </button>
                  </Show>
                  <Show when={rights()?.maySetSeen}>
                    <button
                      type="button"
                      class="message-action"
                      onClick={() => void markSeen([mail().id], !seen())}
                    >
                      {seen() ? "Mark unread" : "Mark read"}
                    </button>
                  </Show>
                </div>
              </Show>
            </header>

            <Switch>
              <Match when={body().kind === "html"}>
                <HtmlBody html={body().value} />
              </Match>
              <Match when={body().kind === "text"}>
                <pre class="message-text">{body().value}</pre>
              </Match>
              <Match when={body().kind === "none"}>
                <p class="message-empty">(no content)</p>
              </Match>
            </Switch>

            <Show when={attachments().length > 0}>
              <ul class="message-attachments">
                <For each={attachments()}>
                  {(part) => (
                    <li>
                      <span class="attachment-name">{part.name ?? "attachment"}</span>
                      <span class="attachment-size">{formatBytes(part.size)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </article>
        );
      }}
    </Show>
  );
}

function HtmlBody(props: { html: string }) {
  let frame: HTMLIFrameElement | undefined;

  // Sanitization is theme-independent, so memoize it on the body alone — flipping the OS
  // theme then only re-runs the (cheaper) dark-mode color remap inside emailSrcdoc, not a
  // full DOMPurify pass.
  const clean = createMemo(() => sanitizeHtml(props.html));

  // The iframe is same-origin (so we can size it to its content) but runs no scripts
  // (no allow-scripts) and blocks remote loads via the CSP in emailSrcdoc.
  function fitToContent() {
    const doc = frame?.contentDocument;
    if (frame && doc) frame.style.height = `${doc.documentElement.scrollHeight}px`;
  }

  // The sandbox neutralizes in-pane navigation, so link clicks do nothing on their own.
  // Because the frame runs no scripts of its own, we delegate from the parent — the frame
  // is same-origin (allow-same-origin), so a click inside it still bubbles to a listener
  // the parent attaches to the frame's document — and open http(s) links in the OS browser
  // (openExternal drops anything else). A fresh srcdoc (e.g. on theme change) loads a new
  // document, so we (re)attach in onLoad; the listener dies with the old document.
  function onFrameClick(event: MouseEvent) {
    // event.target lives in the iframe's realm, so `instanceof Element` (parent realm) is
    // cross-realm-false — duck-type via closest()/.href, which are realm-agnostic. Mouse
    // events target elements in practice, but guard `closest` so a non-Element target (e.g.
    // a Text node) degrades to a no-op instead of throwing.
    const target = event.target as Element | null;
    const anchor =
      typeof target?.closest === "function"
        ? (target.closest("a[href]") as HTMLAnchorElement | null)
        : null;
    if (!anchor) return;
    // Always swallow the click (no in-pane navigation, ever); only http(s) is opened out.
    event.preventDefault();
    openExternal(anchor.href);
  }

  function onLoad() {
    fitToContent();
    frame?.contentDocument?.addEventListener("click", onFrameClick);
  }

  // Re-fit when the pane width changes (content reflows taller/shorter). Keyed on
  // width only, so our own height changes don't feed back into a resize loop.
  onMount(() => {
    if (!frame || typeof ResizeObserver === "undefined") return;
    let lastWidth = 0;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width !== lastWidth) {
        lastWidth = width;
        fitToContent();
      }
    });
    observer.observe(frame);
    onCleanup(() => observer.disconnect());
  });

  return (
    <iframe
      ref={frame}
      class="message-html"
      title="Message content"
      sandbox="allow-same-origin"
      srcdoc={emailSrcdoc(clean(), prefersDark() ? "dark" : "light")}
      onLoad={onLoad}
    />
  );
}
