# Qelo

A JMAP email client built with Tauri and SolidJS. Targets Windows and Linux as a desktop app, plus a Progressive Web App from the same codebase.

> **Status:** Pre-alpha. Scaffolding only — no working email functionality yet.

## Why JMAP

JMAP ([RFC 8620](https://datatracker.ietf.org/doc/html/rfc8620) / [RFC 8621](https://datatracker.ietf.org/doc/html/rfc8621)) is a modern replacement for IMAP. It is JSON over HTTP, supports server-pushed change notifications, and batches operations in a single round trip. It is the protocol Fastmail designed and uses in production; servers like Stalwart and Cyrus also support it.

Qelo speaks JMAP natively rather than treating it as an IMAP afterthought.

## Tech stack

- **[Tauri 2](https://tauri.app/)** — lightweight desktop shell using the OS native webview
- **[SolidJS](https://www.solidjs.com/)** — fine-grained reactivity, no virtual DOM
- **TypeScript** — across the frontend
- **Rust** — Tauri backend for OS integration (keychain, notifications, local cache)
- **Vite** — build tool

## Repository layout

```
src/
├── jmap/         # JMAP protocol layer (no UI concerns)
├── stores/       # SolidJS reactive state
├── components/   # UI components grouped by feature
└── lib/          # Utilities

src-tauri/        # Rust backend (keychain, native integration)
```

## Development

Prerequisites: Node 20+, Rust toolchain, platform-specific Tauri dependencies (see [Tauri prerequisites](https://tauri.app/start/prerequisites/)).

```sh
npm install
npm run tauri dev    # desktop app with hot reload
npm run dev          # web only (PWA target)
npm run build        # web build
```

Type-check:

```sh
npx tsc --noEmit
```

## License

Apache 2.0. See [LICENSE](./LICENSE).
