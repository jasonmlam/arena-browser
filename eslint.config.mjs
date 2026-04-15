import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  {
    ignores: [
      "**/node_modules/**",
      "main.js",
      "coverage/**",
      // Not in tsconfig; recommended rules include type-aware @typescript-eslint rules
      "jest.config.js",
      "esbuild.config.mjs",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        ...globals.browser,
        ...globals.jest,
      },
    },
  },
]);
