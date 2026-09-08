import { coverageConfigDefaults, defineConfig } from "vitest/config";

/**
 * Shared Vitest base for minostack-js workspaces. Separation of concerns:
 *
 * - `vitest` runs the suites (files matching `*.test.ts` under `test/`,
 *   Node environment).
 * - `@vitest/coverage-v8` enforces the repo coverage gate on every
 *   `vitest run --coverage`: 90% lines / branches / functions / statements
 *   over `src/`. The gate fails the run, so `pnpm test` stays honest.
 * - Type safety stays with `tsc --noEmit` (`typecheck` task): Vitest only
 *   transpiles, it never typechecks.
 *
 * @param {{ exclude?: string[] }} [options] Extra coverage excludes, relative
 * to the consuming package root. Use only for type-only modules that V8 still
 * loads at runtime (they carry no executable semantics and are guarded by
 * `tsc` instead) — every entry must name its justification in the caller's
 * `vitest.config.ts`.
 */
export function defineWorkspace(options = {}) {
  const { exclude = [] } = options;
  return defineConfig({
    test: {
      environment: "node",
      include: ["test/**/*.test.ts"],
      coverage: {
        provider: "v8",
        reporter: ["text"],
        include: ["src/**/*.ts"],
        exclude: [...coverageConfigDefaults.exclude, ...exclude],
        thresholds: {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  });
}
