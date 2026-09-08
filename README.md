# minostack-js

> MinoStack ecosystem monorepo — TypeScript, ESM-native, pnpm + Turborepo.

**Status:** `phi` — `@minostack/schema` + `@minostack/mino` + `@minostack/kernel` + runtime adapters + `@minostack/openapi`/`@minostack/graphql` integration. See [Roadmap](#roadmap) and `prompt.md`.

## What is this?

`minostack-js` is the monorepo for the MinoStack ecosystem:

```text
Where does code live?      apps / packages / tooling
How do packages depend?    pnpm workspaces + workspace:* protocol
How are tasks executed?    pnpm + Turborepo
How are packages released? Changesets + npm (independent versions)
```

First package: `@minostack/schema` — TypeScript-first, runtime-agnostic schema + validation with `m.infer`, `parse`/`safeParse`, metadata/facets.

```ts
import { m } from "@minostack/schema";
const User = m.object({ name: m.string(), age: m.number().int().optional() });
type User = m.infer<typeof User>;
User.safeParse(input);
```

Core HTTP: `@minostack/mino` — Fetch-native, runtime-agnostic (`Request`/`Response`), radix router, lazy `Context`, precompiled middleware, `validator("json", schema)`, `createClient`.

Enterprise: `@minostack/kernel` — `@module`, `@injectable`, `@controller`, `Application.create(AppModule)`, DI Container (`singleton|request|transient`), lifecycle (`OnInit`/`OnStart`/`OnStop`/`OnDestroy`), `ExecutionContext`, `Guards`/`Pipes`/`Interceptors`.

Adapters: `@minostack/runtime-node` / `-bun` / `-deno` — `serve(app, { port })`.

Contracts: `@minostack/openapi` (`generateMinoDocument(app, info, schemas)`) and `@minostack/graphql` (`generateMinoSDL`) project canonical schemas to external API descriptions.

Details: [`prompt.md`](./prompt.md), [`blueprint.md`](./blueprint.md), [`codebase.md`](./codebase.md), [`AGENTS.md`](./AGENTS.md).

## Repository structure

```text
minostack-js/
├── .github/workflows/   # CI
├── .changeset/          # changesets
├── apps/                # executable apps (docs, playground, benchmark, website)
├── packages/            # publishable libs, e.g. packages/schema
├── playground/          # dev-time scratch + in-depth refs (private, @minostack/playground)
├── examples/            # compact copy-paste snippets for users (private, @minostack/examples)
├── tooling/             # internal configs, private:true, never published
├── docs/                # repo-level docs
├── scripts/             # repo scripts
├── package.json         # private:true, root scripts only
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.json        # shared base
```

Conventions: `apps/*`, `packages/*`, `tooling/*` workspaces (plus top-level `playground` and `examples`, both private). Scoped names `@minostack/*`. ESM-only. `src/index.ts` entry + explicit `exports` → `dist/`. Shared configs (`@minostack/tsconfig`, `@minostack/eslint-config`, `@minostack/vitest-config`) are consumed via `workspace:*`; external versions via `catalog:` in `pnpm-workspace.yaml`.

## Prerequisites

- `Node.js >= 22` (see `.nvmrc`)
- `pnpm` via Corepack (pinned in `packageManager`)

```bash
corepack enable
```

No global `turbo / typescript / eslint / prettier / changeset` needed — use repo deps via `pnpm exec` or root scripts.

## Quickstart (scaffold)

```bash
git clone <repo-url>
cd minostack-js

corepack enable
pnpm install

pnpm check   # format:check → lint → typecheck → test
pnpm build
```

Targeted work:

```bash
pnpm --filter @minostack/<name> test
pnpm --filter @minostack/<name> test:watch   # vitest watch mode
pnpm --filter @minostack/<name> add <dep>
```

Tooling stack: `oxlint` (correctness, runs first) × `eslint` flat-configs (TS policy via `@minostack/eslint-config`) × `prettier` (format only) · `vitest` (suites + 90% coverage gate via `@minostack/vitest-config`) · `tsx` (playground `dev`/`start`).

## Playground & examples

- `playground/` — dev-time scratch + annotated end-to-end references. `pnpm build`, then `pnpm --filter @minostack/playground start` (once) or `dev` (watch). Every scenario exports a `run()` summary pinned by tests.
- `examples/` — compact copy-paste snippets for users, one concept per file, executed by tests so they cannot rot. See each workspace's `README.md`.

## Scripts

| Script              | What it does                                         |
| ------------------- | ---------------------------------------------------- |
| `pnpm build`        | `turbo run build`                                    |
| `pnpm dev`          | `turbo run dev` (apps with watch mode)               |
| `pnpm test`         | `turbo run test` (`vitest run --coverage`, 90% gate) |
| `pnpm typecheck`    | `turbo run typecheck` (`tsc --noEmit`)               |
| `pnpm lint`         | `turbo run lint`                                     |
| `pnpm format`       | `prettier . --write`                                 |
| `pnpm format:check` | `prettier . --check`                                 |
| `pnpm check`        | format:check + lint + typecheck + test               |
| `pnpm clean`        | `turbo run clean`                                    |
| `pnpm changeset`    | add a changeset (publishable pkgs only)              |
| `pnpm release`      | `changeset publish` (CI / trusted env)               |

## Roadmap

| Package                   | Status                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `@minostack/schema`       | v0.1 core: validation, inference, metadata/facets, Standard Schema (`packages/schema`)         |
| `@minostack/openapi`      | OAS 3.1 + 3.0 conversion + `generateMinoDocument(app, …)` (`packages/openapi`)                 |
| `@minostack/graphql`      | GraphQL SDL + `generateMinoSDL` (`packages/graphql`)                                           |
| `@minostack/mino`         | Fetch-native HTTP, radix router, Context, middleware pipeline, SSE, client (`packages/mino`)   |
| `@minostack/kernel`       | Application/Module/Container/DI, lifecycle, ExecutionContext, Guards/Pipes (`packages/kernel`) |
| `@minostack/runtime-node` | Node adapter — Web-to-Node streams (`packages/runtime-node`)                                   |
| `@minostack/runtime-bun`  | Bun adapter (`packages/runtime-bun`)                                                           |
| `@minostack/runtime-deno` | Deno adapter (experimental, `packages/runtime-deno`)                                           |
| `apps/benchmark`          | Benchmark harness per §31-32                                                                   |

- **Phase 0** Foundation: package architecture, contracts, type system, container design — ✅
- **Phase 1** Mino core: Fetch core, router, context, pipeline — ✅
- **Phase 2** Runtime adapters: Node/Bun/Deno — ✅
- **Phase 3** Kernel: App/Module/Container/DI/lifecycle — ✅
- **Phase 4** Contract ecosystem: DTO, `validator`, `generateMinoDocument`, `generateMinoSDL` — ✅
- **Phase 5** RPC: `createClient`/`hc` typed proxy — ✅
- **Phase 6** Hardening: alloc/GC profiling hooks, observability, docs — 🚧 (harness in `apps/benchmark`)

## Contributing

```bash
pnpm install
pnpm check
pnpm build
```

- `main` + short-lived branches (`feat/…`, `build/…`, `docs/…`, `fix/…`).
- Small commits: `feat: …`, `build: …`, `ci: …`, `docs: …`.
- Changesets for publishable changes only.
- Never commit `dist/`, `node_modules/`, `.turbo/`, `.env`, secrets, or lockfile edits by hand.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) (placeholder) and [`AGENTS.md`](./AGENTS.md).

## License

TBD — `LICENSE` will be added before public distribution.
