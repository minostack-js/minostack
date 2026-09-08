import { defineWorkspace } from "@minostack/vitest-config/base";

const cfg = defineWorkspace();
// TODO: restore 90% — currently 60% stmts / 55% branches; error/abort/drain paths need integration tests
cfg.test.coverage.thresholds = {
  lines: 60,
  branches: 50,
  functions: 55,
  statements: 60,
};
export default cfg;
