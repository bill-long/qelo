/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** JMAP session endpoint. Defaults to the same-origin dev proxy (`/.well-known/jmap`). */
  readonly VITE_JMAP_SESSION_URL?: string;
  /** Dev Basic-auth account email (stopgap until OAuth lands). */
  readonly VITE_JMAP_EMAIL?: string;
  /** Dev Basic-auth account password. Keep in .env.local (gitignored). */
  readonly VITE_JMAP_PASSWORD?: string;
  /** OAuth provider id for the desktop build (see src-tauri auth providers). */
  readonly VITE_JMAP_PROVIDER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
