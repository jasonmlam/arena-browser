import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "**/node_modules/**",
      "main.js",
      "coverage/**",
      "jest.config.js",
      "esbuild.config.mjs",
      "eslint.config.mjs",
      "package.json",
      "src/__tests__/**",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
]);
