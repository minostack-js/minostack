/**
 * Step-driven proof runner. Every practical walks the same four steps —
 * define, validate, generate, compare — with a readable log line per step,
 * so a run can be watched (`proof`) and its verdict re-checked (`test`):
 *
 *   1. define    schemas under test (named, so the log says what is proven)
 *   2. validate  the valid DTO parses; the invalid DTO yields issues
 *   3. generate  converter targets, written byte-exact to `outDir`
 *   4. compare   written files against `snapshotsDir` (or refresh them with
 *                `{ writeSnapshots: true }`, the `proof --update` flow)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { practical as blog } from "./blog.js";
import { practical as enterprise } from "./enterprise.js";
import { practical as signup } from "./signup.js";
import { snapshotsDir } from "./utils.js";
import type { Practical, ProofReport } from "./types.js";

export { snapshotsDir };
export const practicals: readonly Practical[] = [signup, blog, enterprise];

export interface RunOptions {
  /** Refresh `snapshotsDir` instead of comparing (the `--update` flow). */
  readonly writeSnapshots: boolean;
}

function compareOrRefresh(
  practical: Practical,
  file: string,
  content: string,
  snapshotsDir: string,
  options: RunOptions,
): boolean {
  const expectedPath = join(snapshotsDir, file);
  if (options.writeSnapshots) {
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(expectedPath, content);
    console.log(`  4. compare   ${file}: snapshot updated`);
    return true;
  }
  try {
    const expected = readFileSync(expectedPath, "utf8");
    const matched = expected === content;
    console.log(`  4. compare   ${file}: ${matched ? "MATCH" : "DIFF"}`);
    return matched;
  } catch {
    // First run: no snapshot exists yet. A missing baseline is a DIFF, not a
    // crash — `proof --update` records it, reviewable via `git diff`.
    console.log(`  4. compare   ${file}: MISSING snapshot (run proof --update)`);
    return false;
  }
}

export function runPractical(
  practical: Practical,
  outDir: string,
  snapshotsDir: string,
  options: RunOptions,
): ProofReport {
  console.log(`\n## practical: ${practical.name}`);
  console.log(`  1. define    schemas: ${practical.schemaNames.join(", ")}`);
  const report = practical.validate();
  console.log(
    `  2. validate  valid DTO parsed (keys: ${Object.keys(report.valid).join(", ")}), ` +
      `${report.invalidIssues.length} issue(s) on invalid DTO`,
  );
  const warnings = practical.warnings();
  console.log(`               converter warnings: ${warnings.join(", ") || "none"}`);
  mkdirSync(outDir, { recursive: true });
  let failed = 0;
  const files = Object.entries(practical.targets).map(([file, build]) => {
    const content = build();
    writeFileSync(join(outDir, file), content);
    console.log(`  3. generate  ${file} (${content.length} bytes)`);
    const matched = compareOrRefresh(practical, file, content, snapshotsDir, options);
    failed += Number(!matched);
    return { file, bytes: content.length, matched };
  });
  const ok = failed === 0;
  console.log(`  => ${practical.name}: ${ok ? "PROVEN" : "FAILED"}`);
  return { name: practical.name, files, ok };
}
