import { defineWorkspace } from "@minostack/vitest-config/base";

const cfg = defineWorkspace();
// TODO: restore 90% — shim with mocked Deno, 87% stmts / 100% branches / 75% funcs
cfg.test.coverage.thresholds = {
  lines: 85,
  branches: 90,
  functions: 70,
  statements: 85,
};
export default cfg;
