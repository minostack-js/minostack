import { base } from "@minostack/eslint-config/base";

export default [
  ...base,
  {
    // Config core stays portable: no platform APIs in `src/`.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "process", "Buffer"],
    },
  },
];
