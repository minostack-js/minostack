# @minostack/tsconfig

Shared TypeScript compiler configs. Internal only (`private: true`, never published).

- `base.json` — strictness + ESM baseline every workspace extends.
- `library.json` — extends `base.json`, adds declaration emit for publishable packages. `stripInternal: true` keeps `/** @internal */` APIs out of shipped `.d.ts`.

Usage in a package:

```json
{
  "extends": "@minostack/tsconfig/base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "test"]
}
```

Build config:

```json
{
  "extends": "@minostack/tsconfig/library.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Requires `"@minostack/tsconfig": "workspace:*"` in the package's `devDependencies`.
