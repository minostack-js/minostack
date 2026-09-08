import js from "@eslint/js";
import tseslint from "typescript-eslint";
import oxlint from "eslint-plugin-oxlint";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";

/**
 * Shared ESLint flat-config base. Separation of concerns across the lint stack:
 *
 * - `oxlint` (run first via each package's `lint` script) owns `correctness` at speed.
 *   `oxlint.configs["flat/recommended"]` below switches those same rules off here so
 *   nothing is reported twice. It intentionally mirrors `.oxlintrc.json` (correctness);
 *   if that file ever enables more categories, switch this to
 *   `oxlint.buildFromOxlintConfigFile()` instead.
 * - `typescript-eslint` `recommended` (NOT type-checked) owns TS policy without
 *   coupling lint to project references. Opt into `recommendedTypeChecked` per package later.
 * - `eslint-config-prettier` (always last) switches off style rules: Prettier owns formatting.
 */
export const base = [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  ...oxlint.configs["flat/recommended"],
  eslintConfigPrettier,
];
