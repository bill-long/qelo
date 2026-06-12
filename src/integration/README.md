# Integration tests (live Stalwart)

These tests drive the real store actions (`openMailbox`, `loadMore`, `loadThread`, and the
sync actions) against a **live Stalwart JMAP server** — never a mock, per `CLAUDE.md`. They
cover the things the unit suite can't without mocking the client: the batched query→get
round trip, thread collapsing, anchor-based pagination, the PR #4 anchor-recovery paths
(`anchorNotFound` drop-and-re-anchor, the empty-window `position:0` fallback, and the
`loadMore`↔sync stale-snapshot guards), and incremental sync.

They live apart from `pnpm test` (which stays server-free) and run only on demand.

## Running

1. Start the dev server and make sure the test account is seeded — see
   [`dev/stalwart/README.md`](../../dev/stalwart/README.md):

   ```sh
   pnpm dev:server
   ```

2. Run the suite, passing the test account's password (not committed):

   ```sh
   QELO_TEST_PASS='<the dev account password>' pnpm test:integration
   # PowerShell: $env:QELO_TEST_PASS='<pw>'; pnpm test:integration
   ```

Each test creates its own throwaway mailbox + messages and tears them down afterwards, so
runs are independent of the shared seed data and of each other.

## Configuration

| Var              | Default              | Meaning                                  |
| ---------------- | -------------------- | ---------------------------------------- |
| `QELO_JMAP_BASE` | `https://localhost`  | Server base URL (JMAP api at `/jmap/`)   |
| `QELO_TEST_EMAIL`| `test@example.test`  | Test account login (falls back to `QELO_SEED_EMAIL`) |
| `QELO_TEST_PASS` | _(required)_         | Test account password (falls back to `QELO_SEED_PASS`) |

The dev server uses a self-signed certificate; the setup file
(`vitest.integration.setup.ts`) sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for `localhost` only,
mirroring `dev/stalwart/seed.mjs`.
