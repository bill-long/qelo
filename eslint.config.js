import js from "@eslint/js";
import solid from "eslint-plugin-solid/configs/typescript";
import tseslint from "typescript-eslint";

// Scoped intentionally narrow: ESLint exists here ONLY for Solid's
// reactivity rules (destructured props, signals read outside tracking
// scopes, .map() in JSX, etc.) that Biome cannot analyze.
// Formatting and general style are owned by Biome — see biome.json.
export default tseslint.config(
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, solid],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      // Biome already covers these; turn them off to avoid double-reporting.
      "no-unused-vars": "off",
      "no-undef": "off",
      // Type-aware async safety. The JMAP client is async throughout and an
      // unawaited promise here silently drops a server round-trip. Biome can't
      // see types, so these live in ESLint where `project` is wired up.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
);
