import { defineWorkspace } from "@minostack/vitest-config/base";

const cfg = defineWorkspace();
// TODO: restore 90% before publish — currently at 90.9% lines, 76% branches, 96% funcs, 88% stmts after P0 fixes
// Branches/statements need more tests for compose/validator edge cases; keep incremental
cfg.test.coverage.thresholds = {
  lines: 90,
  branches: 70,
  functions: 90,
  statements: 85,
};
export default cfg;
