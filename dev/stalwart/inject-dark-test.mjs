// Inject ONE hard-coded-light email into the dev inbox to eyeball the dark-mode color
// remapping (src/lib/dark-html.ts). In light mode it looks like an ordinary light email; in dark
// mode the authored light colors should flip to match the dark canvas, while the block that
// was *authored dark* stays put (proving already-dark designs are preserved).
//
// Run with: QELO_SEED_PASS='<the test account password>' pnpm dev:inject-dark
// (the dev password is not committed — see dev/stalwart/README.md). Re-running replaces the
// prior copy: it's keyed on a stable Message-ID, so it never touches your other mail.

const BASE = (process.env.QELO_JMAP_BASE ?? "https://localhost").replace(/\/$/, "");
const EMAIL = process.env.QELO_SEED_EMAIL ?? "test@example.test";
const PASS = process.env.QELO_SEED_PASS ?? "test-password";

if (/^https:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const MAIL_CAP = "urn:ietf:params:jmap:mail";
const CORE_CAP = "urn:ietf:params:jmap:core";
const authHeader = `Basic ${Buffer.from(`${EMAIL}:${PASS}`).toString("base64")}`;
const MESSAGE_ID = "qelo-darklight-demo@example.test";
// Shared with seed.mjs: marks dev-seed mail so we can find our own messages by keyword
// (Stalwart's Message-ID header filter is unreliable) without scanning the whole inbox.
const SEED_KEYWORD = "qelo-seed";

async function getSession() {
  const res = await fetch(`${BASE}/.well-known/jmap`, { headers: { Authorization: authHeader } });
  if (!res.ok)
    throw new Error(
      `Session fetch failed: ${res.status} ${res.statusText}. ` +
        "Is the container up and the test account created? See dev/stalwart/README.md.",
    );
  return res.json();
}

async function jmap(session, methodCalls, using = [CORE_CAP, MAIL_CAP]) {
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!res.ok) throw new Error(`JMAP request failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  for (const [name, args] of body.methodResponses) {
    if (name === "error") throw new Error(`JMAP method error: ${JSON.stringify(args)}`);
    for (const key of ["notCreated", "notUpdated", "notDestroyed"]) {
      if (args?.[key] && Object.keys(args[key]).length > 0) {
        throw new Error(`${name} ${key}: ${JSON.stringify(args[key])}`);
      }
    }
  }
  return body.methodResponses;
}

// A deliberately hard-coded-light body that exercises each remap surface, plus one block that
// is authored dark (must be left untouched) and a pure-blue link (the saturated-at-L=0.5 case).
const HTML = `
<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.6">
  <p style="color:#000000">
    This paragraph hard-codes <strong>black text</strong> (color:#000000) on no background.
    In dark mode it should become light and readable.
  </p>

  <div style="background-color:#ffffff;color:#222222;padding:12px;border-radius:6px">
    This card sets a <b>white background</b> with dark-grey text via inline style.
    Dark mode should darken the card and lighten its text.
  </div>

  <p>
    A classic blue link the way old email writes it:
    <a href="https://jmap.io" style="color:#0000ff">https://jmap.io</a>
    (pure #0000ff — HSL lightness 0.5, so it must invert by perceived brightness, not stay dark).
  </p>

  <p><font color="#000080">Navy text via the legacy &lt;font color&gt; attribute.</font></p>

  <table bgcolor="#ffffff" cellpadding="8" style="border-collapse:collapse;width:100%">
    <tr>
      <td style="color:#000000;border:1px solid #cccccc">White bgcolor table cell, black text.</td>
    </tr>
  </table>

  <div style="background-color:#111111;color:#eeeeee;padding:12px;border-radius:6px;margin-top:12px">
    This block was <b>authored dark</b> (bg #111, text #eee). It should look the SAME in dark
    mode — the remap must not invert an already-dark design.
  </div>
</div>`;

const TEXT =
  "This message hard-codes light colors (black text, white backgrounds) plus one already-dark block. View it in dark mode to see the remapping.";

async function main() {
  console.log(`Injecting hard-coded-light demo into ${EMAIL} at ${BASE} …`);
  const session = await getSession();
  const accountId = session.primaryAccounts[MAIL_CAP];
  if (!accountId) throw new Error("No primary mail account in session");

  const [[, mailboxes]] = await jmap(session, [
    ["Mailbox/get", { accountId, ids: null, properties: ["id", "role"] }, "mb"],
  ]);
  const inbox = mailboxes.list.find((m) => m.role === "inbox");
  if (!inbox) throw new Error("No inbox mailbox found");

  // Replace any prior copy so re-runs don't pile up — and stay idempotent even if the demo was
  // moved/archived. Stalwart's Message-ID header filter is unreliable, so (like seed.mjs) find
  // our seed mail by keyword account-wide, then destroy only the rows whose stable Message-ID
  // is exactly ours — so it can never touch unrelated mail.
  const [[, q]] = await jmap(session, [
    ["Email/query", { accountId, filter: { hasKeyword: SEED_KEYWORD } }, "q"],
  ]);
  let stale = [];
  if (q.ids.length > 0) {
    const [[, got]] = await jmap(session, [
      ["Email/get", { accountId, ids: q.ids, properties: ["id", "messageId"] }, "g"],
    ]);
    stale = got.list.filter((e) => (e.messageId ?? []).includes(MESSAGE_ID)).map((e) => e.id);
  }
  if (stale.length > 0) {
    await jmap(session, [["Email/set", { accountId, destroy: stale }, "del"]]);
    console.log(`Removed ${stale.length} prior copy/copies.`);
  }

  const receivedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  await jmap(session, [
    [
      "Email/set",
      {
        accountId,
        create: {
          demo: {
            mailboxIds: { [inbox.id]: true },
            keywords: { [SEED_KEYWORD]: true },
            from: [{ name: "Dark Mode Test", email: "darktest@example.test" }],
            to: [{ name: "Test User", email: EMAIL }],
            subject: "Dark-mode remap demo (hard-coded light colors)",
            receivedAt,
            messageId: [MESSAGE_ID],
            bodyValues: {
              t: { value: TEXT, isTruncated: false, isEncodingProblem: false },
              h: { value: HTML, isTruncated: false, isEncodingProblem: false },
            },
            textBody: [{ partId: "t", type: "text/plain" }],
            htmlBody: [{ partId: "h", type: "text/html" }],
          },
        },
      },
      "set",
    ],
  ]);

  console.log("Done. Open the inbox; pick 'Dark-mode remap demo' and toggle your OS theme.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
