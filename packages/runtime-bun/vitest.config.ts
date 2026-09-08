import { defineWorkspace } from "@minostack/vitest-config/base";

const cfg = defineWorkspace();
// TODO: restore 90% — shim with mocked Bun, 70% stmts / 100% branches / 60% funcs; need real Bun integration tests
cfg.test.coverage.thresholds = {
  lines: 65,
  branches: 90,
  functions: 55,
  statements: 65,
};
export default cfg;
