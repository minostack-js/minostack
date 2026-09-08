# AGENTS.md — minostack-js

> Source of truth for agents working in this repo.
> Distilled from `codebase.md` (monorepo foundation) and `blueprint.md` (`@minostack/schema` v0.1 spec).
> If AGENTS.md conflicts with those files, prefer AGENTS.md for workflow and the blueprint for schema semantics.

## 1. What this repo is

`minostack-js` is a pnpm + Turborepo TypeScript monorepo for the MinoStack ecosystem.

- Package manager + workspaces: **pnpm only**. Lockfile: `pnpm-lock.yaml`.
- Task orchestration + caching: **Turborepo**.
- Language: **TypeScript strict, ESM-only** (`"type": "module"`).
- Runtime baseline: **Node.js >= 22**. Core packages must also stay portable to Bun/Deno.
- Releases: **Changesets**, independent versioning per publishable package.
- CI: GitHub Actions, `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build`.

Current state: **foundation / scaffold only**. No package-specific architecture is hardcoded into the root. First real package will be `@minostack/schema` (see §7).

The foundation answers four questions, nothing more:

```text
Where does code live?        apps / packages / tooling
How do packages depend?      pnpm workspaces + workspace:* protocol
How are tasks executed?      pnpm + Turborepo
How are packages released?   Changesets + npm
```

Keep it deliberately boring.

## 2. Repository shape

```text
minostack-js/
├── .github/workflows/   # CI
├── .changeset/          # changesets (publishable packages only)
├── apps/                # executable apps: docs, playground, benchmark, website
├── packages/            # publishable libs, e.g. packages/schema
├── playground/          # private dev-time scratch + in-depth refs (@minostack/playground)
├── examples/            # private compact user snippets (@minostack/examples)
├── tooling/             # internal configs, private:true, never published
├── docs/                # repo-level docs: development, architecture, releasing
├── scripts/             # repo scripts
├── package.json         # private:true, root scripts only
├── pnpm-workspace.yaml  # apps/*, packages/*, tooling/* + playground + examples + catalog:
├── turbo.json
├── tsconfig.json        # extends tooling/tsconfig/base.json
├── .npmrc / .editorconfig / .prettierignore / prettier.config.mjs
└── README.md
```

- `tooling/` holds shared config only: `tooling/tsconfig` (`@minostack/tsconfig`: `base.json`, `library.json`), `tooling/eslint-config` (`@minostack/eslint-config`: `base`), and `tooling/vitest-config` (`@minostack/vitest-config`: `base`). Extend/import them, never copy them.
- Generic package layout:

```text
packages/<name>/
├── src/index.ts       # clear public entry, internal modules stay internal
├── test/              # vitest suites (*.test.ts)
├── vitest.config.ts   # defineWorkspace() from @minostack/vitest-config/base
├── eslint.config.mjs # ...base + package-specific policy
├── package.json
├── tsconfig.json      # extends @minostack/tsconfig/base.json
├── tsconfig.build.json# extends @minostack/tsconfig/library.json (publishable libs)
└── README.md
```

## 3. Commands (use these, nothing custom)

Root (`package.json`, `private:true`):

```json
{
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "format": "prettier . --write",
    "format:check": "prettier . --check",
    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test",
    "clean": "turbo run clean",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "changeset publish"
  }
}
```

Contributor flow:

```bash
git clone <repo>
cd minostack-js
corepack enable
pnpm install
pnpm check
pnpm build
```

- Turbo cares about the **task interface**, not the implementation. Every buildable package exposes `build`, every TS package exposes `typecheck` (e.g. `tsc --noEmit`), every package exposes `test` / `lint` even if the runner differs. A lib without watch mode does NOT need a fake `dev` script.
- Targeted work: `pnpm --filter @minostack/<name> <script|add>`. Graph-aware runs: `turbo run <task>`.
- Never require global `turbo/typescript/eslint/prettier/changeset`. Use `pnpm exec <tool>` or root scripts.
- `pnpm check` order: format:check → lint → typecheck → test. Keep `build` separate so local checks stay fast.

## 4. Hard rules — dependencies, TS, ESM, boundaries

### pnpm

- Do NOT mix npm/yarn/bun lockfiles. Do NOT commit them. Only `pnpm-lock.yaml`, always committed, never hand-edited.
- Root `devDependencies` = repo tooling only (`turbo`, `prettier`, `@changesets/cli`). Everything a package/tooling workspace runs lives in that workspace's own manifest.
- External versions are centralized in the `catalog:` section of `pnpm-workspace.yaml`. Depend via `"pkg": "catalog:"`, never raw ranges:
- Internal deps use `workspace:*`, never relative `../../other/src` imports:
  ```json
  { "dependencies": { "@minostack/foo": "workspace:*" } }
  ```
- External deps use normal semver. Pin `packageManager: pnpm@x.y.z` + `.nvmrc` (`22`) / version manager. Use `pnpm add -Dw <pkg>` for root, `pnpm --filter <pkg> add [-D] <dep>` otherwise.
- `.npmrc`: keep minimal, e.g. `auto-install-peers=false`. No copy-pasted optimizations.

### Turborepo (`turbo.json`)

- `build` depends on `^build` (build workspace deps first), outputs `dist/**`. `test`/`typecheck` depend on `^build` only if they consume built output — graph must reflect reality. `dev` is `cache:false, persistent:true`. Never cache `dev`/`watch`/side-effectful tasks. Declare `env` (e.g. `NODE_ENV`) only when the task truly reads it. Start local-cache only, no remote cache until needed.

### TypeScript (`tooling/tsconfig`)

- `@minostack/tsconfig/base.json`: `target ES2022`, `strict:true`, `noUncheckedIndexedAccess:true`, `noImplicitOverride:true`, `noFallthroughCasesInSwitch:true`, `forceConsistentCasingInFileNames:true`, `skipLibCheck:true`, NodeNext ESM, `verbatimModuleSyntax:true`. `@minostack/tsconfig/library.json` adds declaration emit + `stripInternal:true`. Root `tsconfig.json` just extends base; packages extend base (typecheck) / library (build) and add their own `outDir`/`include`.
- TypeScript is pinned to `^6` in the catalog: `typescript-eslint` needs the compiler API, which TS 7.0 does not ship (stable API targeted for 7.1). Do NOT bump to 7 until `typescript-eslint` supports it — see `docs/architecture.md`.
- New shared configs go in `tooling/*` only when at least two workspaces genuinely share them (this exception was already applied for tsconfig + eslint-config).

### ESM + build output

- ESM-only. No `require()`, `module.exports`, `.cjs` builds, no dual CJS/ESM "just in case".
- Publishable `package.json` needs explicit `exports` (never `"./*": "./src/*"`), e.g.:
  ```json
  {
    "type": "module",
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
  }
  ```
- Build to `dist/` (`dist/*.js` + `dist/*.d.ts`), `files:["dist"]`, never commit `dist/`. Build tool per package is free (`tsup`/`tsc`/etc.) as long as `pnpm build` works. `clean` must be cross-platform (no Bash-only `rm -rf` if Windows matters).
- Shipment guards on every publishable package: `sideEffects:false` (tree-shaking), `prepublishOnly: pnpm run build` (never ship stale `dist/`), build on `@minostack/tsconfig/library.json` (`stripInternal:true` — mark non-public APIs `/** @internal */`). Verify with `pnpm --filter <pkg> pack --dry-run`: tarball = `dist/` + `package.json` + `README.md`, nothing else.
- Publishing metadata per package: `name (@minostack/*), version, description, license, repository, homepage, bugs, type, exports, types, files, engines, publishConfig: {access:public}`. Tooling packages stay `private:true`.

### Boundaries

- No package reaches into another's `src/`. All cross-package use goes through declared package API + export map. Each package has `src/index.ts` entry.
- `.gitignore` at minimum: `node_modules/ dist/ .turbo/ coverage/ .env .env.* *.log .DS_Store`. Never ignore lockfiles. Never commit secrets / tokens / `.env`.

## 5. Style, lint, test

- One formatter: Prettier (`prettier.config.mjs` + `.prettierignore`, repo-wide `pnpm format`). Two linters, strictly separated: `oxlint` owns `correctness` at speed (policy in root `.oxlintrc.json`, runs first), `eslint` owns TS policy via `@minostack/eslint-config/base` + per-package `eslint.config.mjs`. `eslint-plugin-oxlint` disables overlap, `eslint-config-prettier` (last) disables style rules — never re-enable either category, never run Prettier through ESLint. `.editorconfig`: `utf-8, lf, final newline, space/2`.
- One test runner: **Vitest** (`vitest run --coverage` as each workspace's `test` script, `vitest` as `test:watch`). Shared base in `@minostack/vitest-config/base` (`defineWorkspace()`): Node environment, `test/**/*.test.ts`, V8 coverage over `src/` gated at 90% lines/branches/functions/statements — the gate fails the run, so there is no separate coverage step. Keep test sources to erasable TS (Vitest transpiles; `typecheck` owns types). Future split: unit / type / integration / cross-runtime / benchmarks — keep them separate concepts.
- `playground/` is dev-time scratch + in-depth references (every scenario exports a `run()` summary pinned by tests; runnable via `start`/`dev` with `tsx`). `examples/` is compact copy-paste snippets for users (one concept per file, executed by tests so they cannot rot). Both are `private:true`, never published, no changesets.
- Changesets only for publishable package changes, e.g. `--- "@minostack/schema": minor ---`. Tooling-only changes don't trigger releases. Independent versions per package, no lockstep unless decided later.

## 6. Git + CI

- `main` + short-lived branches (`feat/…`, `build/…`, `docs/…`, `fix/…`). Small focused commits: `feat: …`, `build: configure turbo`, `ci: …`, `docs: …`. No mega "repo setup + CI + docs" commits.
- CI validates: install → format → lint → typecheck → test → build. Matrix covers at least Node 22 (optionally Node current). Bun/Deno tests belong to packages that claim them.
- License: must be `LICENSE` at root before public distribution — currently TBD, don't leave ambiguous once contributors arrive.

## 7. `@minostack/schema` v0.1 — agent spec

First package: `packages/schema` → `@minostack/schema`. Standalone schema system only. NOT a framework / HTTP / OpenAPI / GraphQL library.

> A TypeScript-first, ESM-native, runtime-agnostic schema and validation library with static inference, structured runtime validation, immutable composition, and an extensible metadata foundation.

### 7.1 Public API

```ts
import { m } from "@minostack/schema";

const User = m.object({
  id: m.string().uuid(),
  name: m.string().min(2).max(100),
  email: m.string().email(),
  age: m.number().int().optional(),
});

type User = m.infer<typeof User>;
type In = m.input<typeof User>;
type Out = m.output<typeof User>;

User.parse(input); // throws ValidationError
User.safeParse(input); // { success:true; data } | { success:false; error }
```

- Canonical import is `m`. Keep surface small: `m`, `Schema`, `ValidationError`, `ValidationIssue`, `infer/input/output` helpers. Don't export internals.
- Predictable names: `string number boolean bigint date literal enum object array tuple record union intersection optional nullable lazy`. No clever naming.

### 7.2 Non-negotiables

- **Immutable:** every modifier returns a new schema. `const b = m.string(); b.min(3)` must not mutate `b`.
- **Runtime-agnostic:** only portable ES/TS. No `node:*`, `process`, `Buffer`, streams, Bun/Deno APIs in core (adapters belong in future packages).
- **Zero runtime deps.** Dev deps OK.
- **Explicit over magical:** no silent coercion (`number` schema must reject `"42"`), no hidden transforms. Coercion only via explicit `m.coerce.number()`-style API. Transforms via explicit `.transform(fn)` with distinct `Input`/`Output` types.
- **Executable value object:** public API backed by canonical `SchemaNode { kind, metadata, facets }` graph (object→fields, union→variants, etc.). v0.1 validates with an interpreter `validate(node, input)`; do NOT add `compile()` codegen unless profiled.

### 7.3 v0.1 scope

Must: ESM-only, zero-deps, `string number boolean bigint date literal enum object array tuple record union intersection optional nullable lazy`, `parse/safeParse`, structured `ValidationError/ValidationIssue`, `infer` (+`input/output` where they diverge), metadata + facet extension point, immutability.
Strongly recommended: `transform`, `refine`, `input/output` distinction, object utils (`pick omit partial required extend merge` preserving metadata), Standard Schema interop investigation.
Defer (do NOT implement): `async` validation (`parseAsync` later), implicit/explicit coercion beyond explicit API, compiled validators, JSON Schema / OpenAPI / GraphQL generation, serialization, codegen, CLI, framework adapters.

Schema details to respect:

- `string`: `min max length email url uuid regex startsWith endsWith includes trim toLowerCase toUpperCase` (+`datetime()` for date-strings, not `m.date()` on strings). `number/bigint`: `min max gt gte lt lte multipleOf (+finite safe integer for number)`. Keep `boolean` simple. `m.date()` validates real `Date` only.
- `literal(value)`, `m.enum(['a','b'])` (string-literal arrays, not TS `enum`), `m.array(el).min/max/length`, `m.tuple([...])` (no rest in v0.1), `m.record(k,v)` distinct from `object`, `m.union([...])` with useful errors, `m.discriminatedUnion('type', {...})` as semantic concept, `m.intersection(A,B)` with deterministic conflict failure, `m.lazy(()=>…)` graph refs for recursion.
- `optional()` = `| undefined` (models `prop?` correctly), `nullable()` = `| null`, distinct. `default(v)` makes `Input = T|undefined`, `Output = T`. `refine(pred, {message}?)` is runtime-only. `describe()/meta()` + `facet(ns, payload)` for namespaced extensions.
- Objects: choose + document + test one default for unknown keys; expose `.strip()/.passthrough()/.strict()`.
- Errors: `interface ValidationIssue { code; path: readonly PropertyKey[]; message; expected?; received? }`, `class ValidationError extends Error { issues }`. Stable codes (`invalid_type invalid_literal too_small too_big invalid_format invalid_union custom …`), precise paths (`['users',0,'email']`), no per-validator ad-hoc formats. Messages are not the contract — keep machine-readable `code+params+path` so localization/formatters can be layered later. Validation ≠ parsing (parse may default/transform/coerce); keep terms precise.

### 7.4 Testing / perf / docs for schema work

- Test all five axes: runtime (valid/invalid/edge/nested/metadata/composition), type-level (`infer/input/output`, optional/nullable/union/intersection/transform/recursion via compile asserts — runtime green ≠ types green), composition, errors (codes+paths), cross-runtime (libraries stay portable: `src/` bans platform APIs via ESLint and stays erasable-TS, so Bun/Deno can import them; the Vitest suites themselves run on Node≥22).
- Honest benchmarks (primitive/object/nested/large-array/union/deep/create/repeated, cold vs warm), track uncompressed/min/gzip/brotli, keep tree-shakable modular impl under a simple `m` facade.
- Package README answers immediately: What/Why, define schema, infer type, validate — 5-line example first, no feature-matrix lead.

### 7.5 Schema guiding constraint

Before adding a feature ask: does it improve the canonical model, runtime validation, inference, composition, or extensibility? If not, it doesn't belong in `@minostack/schema`. Keep v0.1 small enough to understand completely, strong enough to build on. Future consumers read nodes/metadata/facets and project outward — they never mutate core state.

## 8. Anti-patterns (do NOT do)

```text
install everything at root / mix lockfiles / publish monorepo as one package
couple turbo.json to one future package / dozens of tooling/* on day one
force identical build per package / CJS compat just in case
reach across src/ dirs / expose src/* via exports / publish without files:[dist]
broad pnpm update inside feature work / hand-edit pnpm-lock.yaml
implicit coerce/transform / OpenAPI-first core semantics / async core in v0.1
giant commits / long-lived branches / un-frozen CI install / committed .env/dist
```

## 9. Done means

Foundation: workspace works, pnpm+Node pinned, catalog centralizes versions, Turbo graph works, shared `@minostack/tsconfig` + `@minostack/eslint-config` + `@minostack/vitest-config` resolve via `workspace:*`, TS base + ESM orientation, predictable root scripts, format+lint+typecheck+test tasks (Vitest suites with a 90% coverage gate), Changesets init, CI green with frozen lockfile, `workspace:*` linking works, explicit `exports` possible, `pack --dry-run` ships only `dist/`+manifest+README, `playground/` + `examples/` workspaces verified by tests, no package architecture baked in.
Schema v0.1: ESM works on Node/Bun/Deno with 0 runtime deps; primitives/objects/composition/recursion stable; deterministic validation with stable paths/codes; `infer` + `input/output` correct; immutable; metadata+facet hook without ecosystem coupling; runtime + type + cross-runtime tests green; README examples work; exports intentionally small.
