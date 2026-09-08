# `@minostack/playground`

Dev-time playground and in-depth references for the `@minostack/*` packages. **Private** (`private: true`) — never published, no changesets.

- `src/` holds annotated, end-to-end scenarios: a `User` domain model (`user.ts`),
  recursion via `lazy` (`recursive.ts`), an OpenAPI document (`openapi.ts`), GraphQL
  SDL (`graphql.ts`), and human-readable error formatting (`errors.ts`).
- Every scenario exports a `run()` summary; `src/index.ts` prints them all.
- `test/playground.test.ts` pins the summaries so the references cannot rot.

Run it (build the libraries first — the playground consumes their `dist/` output):

```bash
pnpm build
pnpm --filter @minostack/playground start   # run once
pnpm --filter @minostack/playground dev     # watch mode (tsx)
```

## Proofs: scenario practicals with snapshots

`src/practicals/` holds small but viable scenarios (`signup`, `blog`, **`enterprise`**) that walk
four steps — **define** schemas, **validate** DTOs, **generate** converter
targets, **compare** with committed snapshots:

```bash
pnpm --filter @minostack/playground proof            # run steps, compare, report
pnpm --filter @minostack/playground proof -- --update # refresh snapshots after review
```

- `proof` regenerates `proof/<name>.openapi.json` + `proof/<name>.graphql`
  (git-ignored scratch) and diffs them against `snapshots/` (committed
  evidence, plain files — open one and read it).
- `test/proof.test.ts` re-runs the same builders in CI and asserts DTO parses,
  exact issue codes/paths, warning codes, and byte-exact snapshot equality —
  plus the runner's own flows (match / diff / missing / refresh) in temp dirs.
- After any converter change, `proof` shows the drift and `--update` records
  the new evidence (review it with `git diff` before committing).

### Enterprise practical

`src/practicals/enterprise.ts` is the enterprise-grade proof: 8 schemas (`User`/`Product`/`Order`/`OrderItem`/`CreateOrderRequest`/`ErrorResponse`/`PaginatedUsers`/`PaginatedProducts`), 7 path groups (`/users`, `/users/{id}`, `/products`, `/products/{id}`, `/orders`, `/orders/{id}`, `/health`) with shared `$ref`s, `components` (`responses` 4 + `parameters` 2 + `requestBodies` + `securitySchemes` bearer/apiKey/openId + `headers` + `pathItems` + `servers` 3 + `tags` 4 + `security` + `externalDocs` + `jsonSchemaDialect` + `webhooks` 3 for 3.1-only), plus GraphQL `Query`/`Mutation`/`Subscription` (union, 3 federation entities with `@key`/`@shareable`, `extend schema @link` header, `schema { query: Query ... }`).

Snapshots:

- `snapshots/enterprise.openapi.json` — 3.1 document with `paths`/`components`/`webhooks`/`servers`
- `snapshots/enterprise.graphql` — plain SDL (`type` + `input` for every object)
- `snapshots/enterprise-federated.graphql` — federated subgraph SDL (`extend schema @link`, `@key`/`@shareable` on types/fields, `type Query`/`Mutation`/`Subscription`, `union`, `schema { ... }`)

For compact copy-paste snippets aimed at library users, see `examples/` instead.
