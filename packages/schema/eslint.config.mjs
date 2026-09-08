import { base } from "@minostack/eslint-config/base";

export default [
  ...base,
  {
    // Blueprint §3.4: core stays runtime-agnostic. No Node/Bun/Deno APIs in `src/`
    // (`test/` runs on Node via Vitest and is exempt). Enforced here, not by convention.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "process", "Buffer"],
    },
  },
];
