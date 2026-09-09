import { base } from "@minostack/eslint-config/base";

export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
      "no-restricted-globals": ["error", "process", "Buffer"],
    },
  },
];
