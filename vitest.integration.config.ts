import { fileURLToPath, URL } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// Integration tests drive the real store actions against a live Stalwart JMAP server
// (CLAUDE.md: never mock the server). Kept in a separate config from the unit suite so
// `pnpm test` stays server-free; run these with `pnpm test:integration` (needs the dev
// container up — see src/integration/README.md).
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    conditions: ["development", "browser"],
  },
  test: {
    // Node, not jsdom: these talk to the server over `fetch` and don't render components,
    // and a Node env lets the self-signed-cert opt-out (NODE_TLS_REJECT_UNAUTHORIZED) apply.
    environment: "node",
    setupFiles: ["./vitest.integration.setup.ts"],
    include: ["src/integration/**/*.itest.ts"],
    // No file parallelism + a single worker: every test shares one account on one server and
    // mutates module-level store singletons + sync cursors, so serialize for determinism.
    // (Each file still gets a fresh module registry via Vitest's default isolation, so the
    // singletons reset between files — only within-file state needs resetStores().)
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    // Real network round-trips against a container are slower than unit tests.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
