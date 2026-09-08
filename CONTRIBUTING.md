# Contributing

Quick start:

```bash
git clone <repo-url>
cd minostack-js
corepack enable
pnpm install
pnpm check
pnpm build
```

- Work on `main` via short-lived branches: `feat/...`, `build/...`, `docs/...`, `fix/...`.
- Keep commits small and focused: `feat: ...`, `build: ...`, `ci: ...`, `docs: ...`.
- Run `pnpm check` before pushing. CI runs `pnpm install --frozen-lockfile`, then `pnpm check`, then `pnpm build`.
- Tests use Vitest: `pnpm --filter @minostack/<name> test` runs the suite with the 90% coverage gate; append `test:watch` for watch mode. Shared config lives in `tooling/vitest-config` — extend it, don't copy it.
- Debugging a behavior end-to-end? Use `playground/` (`pnpm --filter @minostack/playground dev`) instead of throwaway scripts. Adding a user-facing concept? Add a compact snippet to `examples/` — its tests execute every file.
- Add a changeset (`pnpm changeset`) for publishable package changes. Docs/tooling-only changes do not need one.
- Never commit `dist/`, `node_modules/`, `.turbo/`, `.env` files, secrets, or hand-edited lockfiles.

Agent guidance lives in `AGENTS.md`. Schema design context lives in `blueprint.md`.
