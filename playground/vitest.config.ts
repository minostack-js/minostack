import { defineWorkspace } from "@minostack/vitest-config/base";

export default defineWorkspace({
  // `src/index.ts` (scenario printer) and `src/proof.ts` (proof CLI) are
  // runnable entries: importing them under test would only assert
  // `console.log` noise, so they stay out of the coverage gate. What they
  // print is pinned by `test/playground.test.ts` / `test/proof.test.ts`.
  exclude: ["src/index.ts", "src/proof.ts"],
});
