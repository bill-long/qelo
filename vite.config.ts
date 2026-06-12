import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;
const jmapTarget = process.env.VITE_JMAP_TARGET ?? "https://localhost";
// Endpoints proxied to the local Stalwart server in dev (see the proxy note below).
const jmapProxyPaths = ["/.well-known/jmap", "/jmap", "/auth"];

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [solid()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Dev-only proxy to the local Stalwart server (see dev/stalwart). Routing JMAP
    // through the dev server keeps requests same-origin so the webview never has to
    // trust Stalwart's self-signed cert; `secure: false` lets the proxy accept it.
    // The JMAP_TARGET default matches `pnpm dev:server`.
    proxy: Object.fromEntries(
      jmapProxyPaths.map((path) => [
        path,
        { target: jmapTarget, changeOrigin: true, secure: false },
      ]),
    ),
  },
}));
