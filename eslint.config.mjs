import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["*.config.{ts,mjs}", "eslint.config.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/chat/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      ...reactRefresh.configs.vite.rules,
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    files: [
      "apps/chat/server/**/*.ts",
      "apps/chat/*.config.ts",
      "apps/chat/vitest.setup.ts",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["*.config.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    languageOptions: { globals: globals.node },
  },
);
