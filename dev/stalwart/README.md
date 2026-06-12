# Stalwart dev server

A local, throwaway [Stalwart](https://stalw.art/) JMAP server for Qelo development.
Per `CLAUDE.md`, Qelo is developed and tested against a **real** JMAP server, never a
mock.

> ⚠️ **Dev only.** Hardcoded admin password, self-signed TLS, no real domain. Never
> expose this to a network or reuse the config in production.

## Quick start

```sh
pnpm dev:server            # docker compose up -d (from repo root)
```

### One-time setup (first run)

Stalwart v0.16 keeps all configuration in its database, provisioned by a one-time
browser **setup wizard**. On first run the server starts in *bootstrap mode* and
serves the wizard on port 8080; there is no supported way to fully pre-seed this from
a config file in this image (the `config.json` it writes is only a pointer to the
data store, and the binary has no `apply` subcommand). So the very first boot needs a
few clicks:

1. Open the web admin: <http://localhost:8080/admin/>
   Log in with the pinned bootstrap admin (`STALWART_RECOVERY_ADMIN` in
   `docker-compose.yml`): **`admin`** / **`qelo-dev-admin`**.
2. Complete the setup wizard, accepting the defaults where possible:
   - **Hostname:** `localhost`
   - **Default domain:** `example.test`
   - **Storage backend:** RocksDB (default)
   - **Directory:** internal (default)
3. Create an **individual account** (Directory → Accounts):
   - Email: **`test@example.test`** (this is the default the seed script expects)
   - Password: anything that satisfies Stalwart's strength policy — a weak value
     like `test-password` is **rejected**. Use the password Stalwart suggests (or
     your own strong one) and pass it to the seed script via `QELO_SEED_PASS`
     (see below). The password is not committed to the repo.

After this the server persists everything in the named Docker volumes, so subsequent
`pnpm dev:server` runs come up fully configured — no wizard.

> **Note on TLS:** after the wizard, JMAP is served over HTTPS on :443 with a
> self-signed certificate. The seed script and (in dev) the desktop client trust it
> explicitly for `localhost`. If we later want plain HTTP for dev, add an
> `http`-protocol listener with `tls.implicit = false` via Settings → Listeners.

### Seed sample mail

With the test account created and the container running, pass its password via
`QELO_SEED_PASS`:

```sh
QELO_SEED_PASS='<the password you set>' pnpm dev:seed
# (PowerShell: $env:QELO_SEED_PASS='<pw>'; pnpm dev:seed)
```

This connects over JMAP as the test account and injects a handful of threaded sample
emails across the Inbox so the three-pane UI has real data to render. Re-running is
idempotent: it skips messages whose stable `Message-ID` already exists.

Override defaults via env vars:

| Var               | Default              | Meaning                                   |
| ----------------- | -------------------- | ----------------------------------------- |
| `QELO_JMAP_BASE`  | `https://localhost`  | Server base URL (JMAP api at `/jmap/`)    |
| `QELO_SEED_EMAIL` | `test@example.test`  | Test account login                        |
| `QELO_SEED_PASS`  | `test-password`      | Test account password (almost always set) |

> The dev server uses a self-signed certificate; the seed script sets
> `NODE_TLS_REJECT_UNAUTHORIZED=0` for `localhost` only. The desktop app handles the
> dev cert via the `stalwart-dev` provider entry (see `src-tauri` auth config).

## OAuth

Stalwart accepts **any `client_id` with PKCE** by default
(`requireClientRegistration = false`), so Qelo's dev client (`qelo-dev`) needs no
pre-registration. Endpoints are discovered from
`/.well-known/oauth-authorization-server`; the token endpoint is `/auth/token`.

## Tear down

```sh
docker compose -f dev/stalwart/docker-compose.yml down        # keep data
docker compose -f dev/stalwart/docker-compose.yml down -v     # wipe volumes too
```
