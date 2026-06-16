import { fileURLToPath, URL } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so the Tauri dev-server options don't apply to tests.
export default defineConfig({
  // `hot: false` disables solid-refresh (HMR) — irrelevant in a test run, and its virtual
  // `@solid-refresh` module otherwise fails to resolve under vitest (so .tsx component tests load).
  plugins: [solid({ hot: false })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // Use the browser/dev exports of solid-js, matching how the app runs.
    conditions: ["development", "browser"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Pure protocol/util layers plus any component tests under src/.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
