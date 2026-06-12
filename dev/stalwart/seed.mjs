// Seed the local Stalwart dev server with sample threaded mail so Qelo's
// three-pane UI has realistic data to render.
//
// Prereqs: `pnpm dev:server` is running and the test account exists (see
// dev/stalwart/README.md "One-time setup"). Run with: `node dev/stalwart/seed.mjs`.
//
// This is a dev utility, not app code — it talks to the server over JMAP using
// HTTP Basic auth (which Stalwart accepts) and creates messages with Email/set.

// The dev server uses a self-signed certificate. Trust it for localhost only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BASE = (process.env.QELO_JMAP_BASE ?? "https://localhost").replace(/\/$/, "");
const EMAIL = process.env.QELO_SEED_EMAIL ?? "test@example.test";
const PASS = process.env.QELO_SEED_PASS ?? "test-password";

const MAIL_CAP = "urn:ietf:params:jmap:mail";
const CORE_CAP = "urn:ietf:params:jmap:core";
const authHeader = `Basic ${Buffer.from(`${EMAIL}:${PASS}`).toString("base64")}`;

// Custom keyword stamped on every message we create. Keywords are client-set and
// round-trip reliably, so we filter on it to find prior seed runs (rather than
// scanning the whole inbox) and to scope idempotency to our own messages.
const SEED_KEYWORD = "qelo-seed";

/** Fetch the JMAP session object via the well-known endpoint. */
async function getSession() {
  const res = await fetch(`${BASE}/.well-known/jmap`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    throw new Error(
      `Session fetch failed: ${res.status} ${res.statusText}. ` +
        `Is the container up and the test account created? See dev/stalwart/README.md.`,
    );
  }
  return res.json();
}

/** Make a batched JMAP request and return the methodResponses. */
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
    // `/set` methods report per-item failures in notCreated/notUpdated/notDestroyed
    // (the method response itself is still a success). Surface those — otherwise a
    // rejected Email/set looks like success and we silently seed nothing.
    for (const key of ["notCreated", "notUpdated", "notDestroyed"]) {
      if (args?.[key] && Object.keys(args[key]).length > 0) {
        throw new Error(`${name} ${key}: ${JSON.stringify(args[key])}`);
      }
    }
  }
  return body.methodResponses;
}

/** Sample threads. Each thread is an array of messages; replies thread via references. */
const THREADS = [
  [
    {
      from: { name: "Ada Lovelace", email: "ada@example.test" },
      subject: "Welcome to Qelo",
      seen: false,
      text: "Hi there,\n\nThis is your first message in the Qelo dev inbox. JMAP makes switching folders feel instant.\n\n— Ada",
      html: "<p>Hi there,</p><p>This is your first message in the Qelo dev inbox. <strong>JMAP</strong> makes switching folders feel instant.</p><p>— Ada</p>",
    },
    {
      from: { name: "Grace Hopper", email: "grace@example.test" },
      subject: "Re: Welcome to Qelo",
      seen: false,
      text: "Looks great. Threading works too — this reply should collapse under the same conversation.\n\n— Grace",
      html: "<p>Looks great. Threading works too — this reply should collapse under the same conversation.</p><p>— Grace</p>",
    },
  ],
  [
    {
      from: { name: "Build Bot", email: "ci@example.test" },
      subject: "Nightly build passed ✅",
      seen: true,
      text: "All 1,284 tests passed. Artifacts are attached to the run.",
      html: "<p>All 1,284 tests passed. Artifacts are attached to the run.</p>",
    },
  ],
  [
    {
      from: { name: "Newsletter", email: "news@example.test" },
      subject: "This week in email standards",
      seen: false,
      text: "JMAP adoption continues to grow. Remote images in this message are blocked by default for privacy.",
      html: '<p>JMAP adoption continues to grow.</p><img src="https://tracker.example.com/pixel.gif" alt="tracking pixel"><p>Remote images in this message are blocked by default for privacy.</p>',
    },
  ],
];

async function main() {
  console.log(`Seeding ${EMAIL} at ${BASE} …`);
  const session = await getSession();
  const accountId = session.primaryAccounts[MAIL_CAP];
  if (!accountId) throw new Error("No primary mail account in session");

  // Find the Inbox mailbox by role.
  const [[, mailboxes]] = await jmap(session, [
    ["Mailbox/get", { accountId, ids: null, properties: ["id", "role", "name"] }, "mb"],
  ]);
  const inbox = mailboxes.list.find((m) => m.role === "inbox");
  if (!inbox) throw new Error("No inbox mailbox found");

  // Collect existing Message-IDs from prior seed runs so re-runs don't duplicate.
  // Filtering by our keyword bounds this to messages we created, so it never misses
  // ids in a large inbox and never collides with the user's real mail.
  const [[, q]] = await jmap(session, [
    ["Email/query", { accountId, filter: { inMailbox: inbox.id, hasKeyword: SEED_KEYWORD } }, "q"],
  ]);
  let existing = new Set();
  if (q.ids.length > 0) {
    const [[, got]] = await jmap(session, [
      ["Email/get", { accountId, ids: q.ids, properties: ["messageId"] }, "g"],
    ]);
    existing = new Set(got.list.flatMap((e) => e.messageId ?? []));
  }

  let created = 0;
  let day = 0;
  for (const [ti, thread] of THREADS.entries()) {
    let parentRef = null; // Message-ID of the previous message in this thread.
    const refChain = [];
    for (const [mi, msg] of thread.entries()) {
      day += 1;
      // Stable id derived from position. Re-running is idempotent on servers that
      // preserve a client-set Message-ID (per RFC 8621), which Stalwart does.
      const messageId = `qelo-seed-${ti}-${mi}@example.test`;
      if (existing.has(messageId)) {
        parentRef = messageId;
        refChain.push(messageId);
        continue;
      }

      const receivedAt = new Date(Date.now() - day * 3600_000)
        .toISOString()
        .replace(/\.\d+Z$/, "Z");
      const create = {
        mailboxIds: { [inbox.id]: true },
        keywords: { [SEED_KEYWORD]: true, ...(msg.seen ? { $seen: true } : {}) },
        from: [msg.from],
        to: [{ name: "Test User", email: EMAIL }],
        subject: msg.subject,
        receivedAt,
        messageId: [messageId],
        ...(parentRef ? { inReplyTo: [parentRef], references: [...refChain] } : {}),
        bodyValues: {
          t: { value: msg.text, isTruncated: false, isEncodingProblem: false },
          h: { value: msg.html, isTruncated: false, isEncodingProblem: false },
        },
        textBody: [{ partId: "t", type: "text/plain" }],
        htmlBody: [{ partId: "h", type: "text/html" }],
      };

      await jmap(session, [["Email/set", { accountId, create: { new: create } }, "set"]]);
      created += 1;
      parentRef = messageId;
      refChain.push(messageId);
    }
  }

  console.log(`Done. Created ${created} message(s) across ${THREADS.length} thread(s).`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
