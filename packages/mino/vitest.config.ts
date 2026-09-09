import { defineWorkspace } from "@minostack/vitest-config/base";

const cfg = defineWorkspace();
// Uniform 90% gate restored pre-publish (stmts ~95%, branches ~90.2%, funcs ~98%, lines ~96.5%).
// Branch margin is thin — keep compose/validator/context edge tests green when touching those files.
cfg.test.coverage.thresholds = {
  lines: 90,
  branches: 90,
  functions: 90,
  statements: 90,
};
export default cfg;
