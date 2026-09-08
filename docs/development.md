# Development

Setup:

```bash
corepack enable
pnpm install
```

Validate and build:

```bash
pnpm check   # format:check -> lint -> typecheck -> test
pnpm build
```

Targeted work on one package:

```bash
pnpm --filter @minostack/schema test
pnpm --filter @minostack/schema add -D <dep>
```

Graph-aware runs:

```bash
pnpm exec turbo run <task> --filter=@minostack/schema...
```

Rules:

- No global `turbo` / `typescript` / `eslint` / `oxlint` / `prettier` / `vitest` / `changeset`. Use `pnpm exec <tool>` or root scripts.
- Internal deps use `workspace:*`, never relative `../../other/src` imports. External versions are centralized in the `catalog:` section of `pnpm-workspace.yaml` — depend on them via `"pkg": "catalog:"`, never raw ranges.
- Every package exposes the same task interface (`build`, `typecheck`, `test`, `lint`, `clean`). Turbo cares about the interface, not the implementation.
- Tests run on source via **Vitest** (`vitest run --coverage`). Keep test sources to erasable TypeScript only (no enums, namespaces, or parameter properties) — Vitest transpiles without typechecking; `tsc --noEmit` (`typecheck` task) owns type safety.

Testing:

```bash
pnpm test                                            # all suites + 90% coverage gate
pnpm --filter @minostack/schema test                 # one package
pnpm --filter @minostack/schema test:watch           # watch mode (no coverage)
pnpm --filter @minostack/schema exec vitest run -t "unions"  # name filter
```

- Shared config lives in `tooling/vitest-config` (`@minostack/vitest-config/base`, consumed via `defineWorkspace()` in each `vitest.config.ts`). It sets the Node environment, `test/**/*.test.ts` includes, and V8 coverage over `src/` with the repo gate: 90% lines / branches / functions / statements. The gate fails the run — `pnpm test` stays honest without a separate coverage step.
- Extra coverage `exclude` entries are reserved for type-only modules V8 still loads at runtime (no executable semantics, guarded by `tsc` instead). Each entry must justify itself in a comment — see `playground/vitest.config.ts` (`src/index.ts`, the runnable entry).
- Cross-package test imports (e.g. `@minostack/schema` in `packages/openapi/test/`) resolve to built `dist/`, so `test` keeps depending on `^build` in `turbo.json`. Cross-runtime portability is enforced structurally instead: `src/` bans `node:*` / `process` / `Buffer` via each package's `eslint.config.mjs`, so the libraries stay importable on Bun/Deno while the suites run on Node.

Playground (`playground/`, `@minostack/playground`, private):

```bash
pnpm build                                # playground consumes dist/
pnpm --filter @minostack/playground start # run all scenarios once
pnpm --filter @minostack/playground dev   # watch mode (tsx)
```

- Debug-time scratch space plus in-depth, annotated references. Every scenario exports a `run()` summary printed by `src/index.ts`; `test/playground.test.ts` pins the summaries so references cannot rot. Never published, no changesets.

Examples (`examples/`, `@minostack/examples`, private):

- Compact copy-paste snippets for library users (one concept per file). `test/examples.test.ts` executes every snippet — examples are docs that fail CI when they lie. Never published, no changesets.

Lint stack (three layers, no overlap):

```text
oxlint          correctness, at speed (`lint` runs it first; policy in `.oxlintrc.json`)
eslint          TS policy (`@minostack/eslint-config/base` + package `eslint.config.mjs`)
prettier        formatting only (repo-wide `pnpm format`; never via eslint-plugin-prettier)
```

- `eslint-plugin-oxlint` switches off ESLint rules oxlint already covers; `eslint-config-prettier` (last) switches off style rules. Don't re-enable either category.
- Package-specific policy lives in that package's `eslint.config.mjs` (e.g. `@minostack/schema` bans `node:*` imports and `process`/`Buffer` globals in `src/` to enforce runtime-agnostic core).
- Shared configs live in `tooling/` (`@minostack/tsconfig`, `@minostack/eslint-config`, both `private: true`). Extend them, don't copy them. Prettier stays a single root `prettier.config.mjs` — one file is already DRY.

TypeScript is pinned to `^6` in the catalog (not 7): `typescript-eslint` needs the compiler API, which TypeScript 7.0 does not ship (expected in 7.1). Revisit after 7.1 lands (see `docs/architecture.md`).
