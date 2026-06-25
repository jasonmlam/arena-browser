import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  ...obsidianmd.configs.recommended,
  {
    ignores: [
      "**/node_modules/**",
      "main.js",
      "coverage/**",
      "jest.config.js",
      "esbuild.config.mjs",
      "package.json",
      "src/__tests__/**",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
];
