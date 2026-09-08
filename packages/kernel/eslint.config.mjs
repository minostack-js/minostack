import { base } from "@minostack/eslint-config/base";

export default [
  ...base,
  // Narrow override: `any[]` is intentionally used for DI constructor `new (...args: any[]) => unknown`
  // to allow `new (svc: UserService)` etc. with `strict` — keep scoped, not global.
  {
    files: ["src/module.ts", "src/provider.ts", "src/container.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["node:*"] }],
    },
  },
];
