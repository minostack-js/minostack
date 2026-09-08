# `@minostack/examples`

Compact, copy-pasteable examples for the `@minostack/*` packages. **Private** (`private: true`) — never published, no changesets.

| File                        | Shows                                            |
| --------------------------- | ------------------------------------------------ |
| `src/basic-user.ts`         | Define a schema, infer its type, validate input  |
| `src/refine-transform.ts`   | Runtime refinements + input/output transforms    |
| `src/recursive-category.ts` | Self-referencing schemas via `m.lazy`            |
| `src/openapi-document.ts`   | Project schemas to an OpenAPI 3.1 document       |
| `src/graphql-sdl.ts`        | Project schemas to GraphQL SDL                   |
| `src/error-handling.ts`     | Branch on machine-readable issue codes and paths |

Every file is a standalone snippet: copy it into your project, `pnpm add @minostack/schema` (plus `@minostack/openapi` / `@minostack/graphql` where used), done. `test/examples.test.ts` executes each snippet so the docs cannot rot:

```bash
pnpm build                              # libraries first (examples consume dist/)
pnpm --filter @minostack/examples test  # executes every snippet
```

For annotated, end-to-end scenarios, see `playground/` instead.
