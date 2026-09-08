# Releasing

Packages are versioned independently with [Changesets](https://github.com/changesets/changesets).

Flow:

```text
Change
  |
  v
Changeset (`pnpm changeset`)
  |
  v
CI validation
  |
  v
Changeset version (`pnpm version-packages`)
  |
  v
Package publish (`pnpm release`)
  |
  v
Git tags / release notes
```

Rules:

- Changesets only for publishable package changes (`packages/*`). Tooling-only changes do not trigger releases.
- Publishing happens only from the trusted release environment, never from a dev machine.
- Each publishable package sets `publishConfig.access: public` and `files: ["dist"]`.
- Shipment guards (already wired, keep them): `sideEffects: false`, `prepublishOnly: pnpm run build`, `stripInternal: true` via `@minostack/tsconfig/library.json`. Verify with `pnpm --filter <pkg> pack --dry-run` — the tarball must contain only `dist/`, `package.json`, and `README.md`.
- Before the first publish: add root `LICENSE`, fill `repository` / `homepage` / `bugs` in each publishable manifest, and set up npm provenance (`id-token: write` in the release workflow).
