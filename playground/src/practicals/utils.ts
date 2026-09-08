/**
 * Leaf helpers for practicals. Deliberately dependency-free (no imports from
 * sibling practicals or the runner) so the module graph stays acyclic:
 * scenarios and `index.ts` both import from here, never from each other.
 */

import { fileURLToPath } from "node:url";

/** Absolute path of the committed snapshots (readable evidence on disk). */
export const snapshotsDir = fileURLToPath(new URL("../../snapshots/", import.meta.url));

/**
 * Union of converter warning codes across results, deduplicated. Shared so
 * both empty (blog) and non-empty (signup) warning sets cover it — and so no
 * practical silently drops an approximation notice.
 */
export function collectWarnings(
  results: ReadonlyArray<{ readonly warnings: ReadonlyArray<{ readonly code: string }> }>,
): string[] {
  const codes = new Set<string>();
  for (const result of results) {
    for (const warning of result.warnings) {
      codes.add(warning.code);
    }
  }
  return [...codes];
}
