import { base } from "@minostack/eslint-config/base";

export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["node:*", "node:fs", "node:path", "node:http"] },
      ],
    },
  },
];
