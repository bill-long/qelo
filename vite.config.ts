import { Buffer } from "node:buffer";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import solid from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // Read through loadEnv (not process.env directly) so the proxy target honors values
  // set in `.env*` files — reading process.env at module load would miss those.
  const jmapTarget = env.VITE_JMAP_TARGET ?? "https://localhost";

  // Only skip TLS verification for the local loopback dev server (self-signed cert).
  // If the target is overridden to a remote host, keep verification on so a bad cert
  // isn't silently accepted.
  const loopbackTarget = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(jmapTarget);
  const proxyBase = (): ProxyOptions => ({
    target: jmapTarget,
    changeOrigin: true,
    secure: !loopbackTarget,
  });

  // EventSource can't set an Authorization header, so the dev proxy injects the dev
  // Basic-auth credentials for the push endpoint only (regular JMAP requests carry
  // their own header from the app).
  const eventSourceProxy: ProxyOptions = {
    ...proxyBase(),
    configure(proxy) {
      const user = env.VITE_JMAP_EMAIL;
      const pass = env.VITE_JMAP_PASSWORD;
      if (user && pass) {
        const header = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
        proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("authorization", header));
      }
    },
  };

  return {
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
      // The eventsource entry is listed first (more specific) so it wins over /jmap.
      proxy: {
        "/jmap/eventsource": eventSourceProxy,
        "/.well-known/jmap": proxyBase(),
        "/jmap": proxyBase(),
        "/auth": proxyBase(),
      },
    },
  };
});
