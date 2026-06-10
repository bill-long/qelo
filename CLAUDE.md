# Qelo — AI agent instructions

Qelo is a JMAP email client. Tauri 2 desktop shell, SolidJS frontend, TypeScript everywhere on the JS side, Rust in the backend.

## Architecture

The JMAP protocol layer lives in TypeScript so the PWA and desktop builds share the same client code. The Rust backend (`src-tauri/`) is reserved for things browsers cannot do: OS keychain, native notifications, local cache, background sync.

Do not duplicate JMAP logic in Rust unless a feature genuinely needs it.

### Layers

- `src/jmap/` — pure protocol. No SolidJS imports, no UI concerns. Just request/response handling and types.
- `src/stores/` — SolidJS signals and stores. Reactive state derived from JMAP responses.
- `src/components/` — UI grouped by feature (`mailbox/`, `thread-list/`, `thread-view/`, `composer/`, `layout/`).
- `src/lib/` — pure utilities (sanitization, date formatting, mime helpers).

State flows: JMAP response → store update → component re-render. Components must not call the JMAP client directly; they read from stores and dispatch through store actions.

## JMAP references

- [RFC 8620](https://datatracker.ietf.org/doc/html/rfc8620) — core JMAP
- [RFC 8621](https://datatracker.ietf.org/doc/html/rfc8621) — JMAP for Mail
- [jmap.io](https://jmap.io/) — spec hub and examples

Types in `src/jmap/types.ts` follow the RFC field names exactly. Do not rename fields to be more idiomatic — keeping the wire format and types aligned makes debugging much easier.

## Conventions

- TypeScript `strict` and `noUncheckedIndexedAccess` are on. Don't disable them locally.
- Path alias `@/*` maps to `src/*`. Use it for cross-layer imports.
- SolidJS components use `function Name(props: ...)` not arrow functions, for better stack traces.
- Don't introduce a global state library (Redux, Zustand). SolidJS stores are sufficient.
- Don't add UI component libraries without discussion. The design language is meant to be distinctive.

## What to avoid

- React patterns. SolidJS reactivity is different — destructuring props breaks reactivity, `useEffect`-style hooks don't exist. Reach for `createEffect`, `createMemo`, `createResource`.
- Treating JMAP like IMAP. JMAP batches; prefer one request with multiple method calls over chained promises.
- Mocking the JMAP server in tests. Use a real JMAP server (Stalwart in a container) for integration tests once we add them.

## License

Apache 2.0. New files should not include a license header — the LICENSE file at the repo root covers everything.
