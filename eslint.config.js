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
    },
  },
);
