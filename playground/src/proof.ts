/**
 * Proof CLI. Regenerates every practical's targets, prints the four steps per
 * practical, and compares the fresh output with the committed snapshots:
 *
 *   pnpm --filter @minostack/playground proof            # verify + show steps
 *   pnpm --filter @minostack/playground proof -- --update # refresh snapshots
 *
 * Verification also runs inside `test/proof.test.ts`, so CI fails on drift
 * even when nobody runs this command. Snapshots live in `snapshots/` —
 * plain files, there to read.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { practicals, runPractical, snapshotsDir } from "./practicals/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const update = process.argv.includes("--update");
const outDir = update ? snapshotsDir : join(root, "proof");

let ok = true;
for (const practical of practicals) {
  const report = runPractical(practical, outDir, snapshotsDir, { writeSnapshots: update });
  ok = ok && report.ok;
}

if (update) {
  console.log("\nproof: snapshots refreshed — review with git diff, then run test");
} else {
  console.log(
    ok
      ? "\nproof: ALL MATCH — the snapshots prove the goals"
      : "\nproof: DIFFS FOUND — inspect proof/ vs snapshots/, or refresh with proof -- --update",
  );
}
process.exitCode = ok ? 0 : 1;
