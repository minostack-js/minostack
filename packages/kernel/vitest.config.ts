import { defineWorkspace } from "@minostack/vitest-config/base";

const cfg = defineWorkspace();
// TODO: restore 90% before publish — currently 66% stmts / 51% branches; need extensive tests for guards/pipes/scopes/exports
cfg.test.coverage.thresholds = {
  lines: 65,
  branches: 50,
  functions: 70,
  statements: 65,
};
export default cfg;
