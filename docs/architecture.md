# Architecture

Repository task graph (`turbo.json`):

```text
                          minostack-js
                               |
               +---------------+---------------+
               |               |               |
             apps           packages         tooling
               |               |               |
               |               |         shared repository
               |               |          infrastructure
               |               |
               |        independent npm
               |          packages
               |
           executable
           applications


              pnpm
                |
                v
         Workspace Graph
                |
                v
             Turbo
                |
        +-------+--------+
        v       v        v
      build   test   typecheck
        |       |        |
        +-------+--------+
                v
              CI/CD
```

Conventions:

- Workspaces: `apps/*` (executables), `packages/*` (publishable `@minostack/*` libs), `tooling/*` (internal, `private: true`).
- `tooling/` holds shared config only: `@minostack/tsconfig` (`base.json`, `library.json`) and `@minostack/eslint-config` (`base`). Packages consume them via `workspace:*` + `extends` / `import`; Prettier stays one root config. External versions are centralized in the `catalog:` of `pnpm-workspace.yaml`.
- `build` depends on `^build` (workspace deps build first), outputs `dist/**`. `typecheck` / `test` also depend on `^build`: downstream typechecks resolve workspace `dist/*.d.ts`, and downstream tests import workspace packages through their `exports` maps (which point at `dist/`).
- Each package publishes from `dist/` (`dist/*.js` + `dist/*.d.ts`) with an explicit `exports` map. No `src/*` exposure.
- Publishable libs set `sideEffects: false` (tree-shaking), `prepublishOnly: pnpm run build` (never ship stale `dist/`), and build on `@minostack/tsconfig/library.json` so `stripInternal: true` keeps `/** @internal */` APIs out of shipped `.d.ts`.

Decision record — TypeScript stays on `^6`:

- `typescript-eslint` reads the compiler API, which TypeScript 7.0 does not export (stable API targeted for 7.1). Pinning `typescript@7` today breaks ESLint at install (peer range) and at runtime (`typescript-estree` crash).
- Revisit when 7.1 ships a stable API _and_ `typescript-eslint` supports it: bump the `typescript` catalog entry, re-run `pnpm check` + `pnpm build`, and only then consider `tsgo` for speed.
