# @minostack/graphql

> Convert `@minostack/schema` graphs to GraphQL SDL — `type` + `input` for every object, shared enums/unions/scalars, deterministic names. Everything converts; approximations are warned, never silent.

```ts
import { m } from "@minostack/schema";
import { sdl } from "@minostack/graphql";

const result = sdl({ User: m.object({ id: m.string(), age: m.number().int().optional() }) });
console.log(result.sdl);
// type User {
//   id: String!
//   age: Int
// }
//
// input UserInput {
//   id: String!
//   age: Int
// }
```

## Rules

- **Split by side.** Every object emits `type X` (output) + `input XInput` (input). Non-null (`!`) means required _and_ non-undefined _and_ non-null on that side.
- **Names**: map key for roots, `metadata.id` for nested schemas, otherwise deterministic `${Parent}${Field}` derivation. Collisions and sanitization are warned (`name-sanitized`).
- **Custom scalars** (`BigInt`, `DateTime`, `JSON`) are declared only when used.
- **Defaults** become SDL literals on inputs (`role: Role = member`); non-serializable defaults are omitted with a warning.
- `describe()` becomes `"""..."""`, `deprecated` becomes `@deprecated` (string → `reason:`).
- Every call returns `{ sdl, warnings }`. Warning codes are stable; messages are not.

## Enterprise: Query / Mutation / Subscription + Federation

```ts
import { m } from "@minostack/schema";
import { sdl } from "@minostack/graphql";

// Federated entities share a @key; fields can be @shareable/@external etc via facets
const User = m
  .object({ id: m.string().uuid(), email: m.string().email() })
  .meta({ id: "User" })
  .facet("federation", { key: "id", shareable: true });

const Product = m
  .object({ id: m.string().uuid(), name: m.string() })
  .meta({ id: "Product" })
  .facet("federation", { key: "id" });

// Query/Mutation/Subscription are `type` only (no `input`) with `schema { query: Query ... }`
const result = sdl(
  { User, Product },
  {
    query: {
      me: User,
      user: User, // args via facet("field", { args: { id: m.string().uuid() } }) also supported
      products: m.array(Product),
    },
    mutation: { createProduct: Product },
    subscription: { productUpdated: Product },
    federation: { enabled: true, version: "2.3" }, // emits `extend schema @link(...)`
  },
);
result.sdl;
// extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key", ...])
// type User @key(fields: "id") @shareable { id: String! email: String! }
// type Product @key(fields: "id") { ... }
// type Query { me: User! user: User! products: [Product!]! }
// type Mutation { createProduct: Product! }
// type Subscription { productUpdated: Product! }
// schema { query: Query mutation: Mutation subscription: Subscription }
```

- **`query` / `mutation` / `subscription`** accept `Record<string, Schema>` or an object `Schema` (`m.object({...})`). Keys become field names; values are return types. The function also respects `Query`/`Mutation`/`Subscription` objects passed directly in the first `types` map.
- **Field args** via `facet("field", { args: { id: m.string().uuid(), page: m.number().int().default(1) } })` on the return-type schema — the SDL renders them as `field(arg: Type): ReturnType`. The facet wrapper reuses the underlying type’s declaration (no duplicate type).
- **Federation** per-type/field: `facet("federation", { key: "id", keys: ["id","sku"], shareable: true, extends: true, external: true, provides: "field", requires: "field", override: "otherService", tags: ["t"], inaccessible: true, directives: ["@custom"] })`. Supported facets: `federation`, `graphql.federation`, `apollo.federation` (alias).
  - Type-level: `@key`, multiple `@key`, `@shareable`, `@tag`, `@override`, `@inaccessible`, custom `directives`. `extends: true` renders `extend type X` instead of `type X`.
  - Field-level: `@shareable`, `@external`, `@provides`, `@requires`, `@override`, `@tag`, `@inaccessible`, custom directives.
  - Federation directives only emit when `federation.enabled` is true; plain `sdl({User})` stays clean.
- **Top-level federation** `sdl(types, { federation: { enabled: true, version: "2.3", import: ["@key", ...] } })` prepends `extend schema @link(...)` and enables the directive rendering. `version` defaults to `2.3`.
- Playground proof: `playground/src/practicals/enterprise.ts` builds a federated subgraph with `User`/`Product`/`Order` as `@key` entities, `Query`/`Mutation`/`Subscription` roots (7 query fields, 3 mutation fields, 2 subscription fields including a `union`), and a plain non-federated counterpart; both are snapshotted byte-exact in `snapshots/enterprise*.graphql`.
- Module-federation / subgraph compatibility: the SDL is a valid Apollo Federation v2 subgraph SDL (validated via `extend schema @link` + entity `@key`), ready for gateway composition and for module-federation hosts that consume the subgraph SDL as a shared contract.

## Mapping table (100/100: exact or warned)

| Kind                                                              | SDL                                                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| string (formats → `String`)                                       | `String`; normalizers ⚠️ `normalizer-dropped`                                                      |
| number (int/safe → `Int`, else `Float`; bounds not representable) | `Int` / `Float`                                                                                    |
| boolean                                                           | `Boolean`                                                                                          |
| bigint                                                            | `BigInt` scalar                                                                                    |
| date                                                              | `DateTime` scalar                                                                                  |
| literal string                                                    | single-value `enum`                                                                                |
| literal number/boolean                                            | `Int`/`Float`/`Boolean` ⚠️ `literal-fallback`                                                      |
| literal null/undefined                                            | `String` ⚠️ `literal-fallback`                                                                     |
| enum                                                              | `enum` (values sanitized, collisions warned)                                                       |
| null/undefined standalone                                         | `String` ⚠️ `literal-fallback`                                                                     |
| any/unknown                                                       | `JSON` scalar                                                                                      |
| never                                                             | `JSON` scalar ⚠️ `never-as-json`                                                                   |
| object                                                            | `type` + `input`; required ⟺ `!`; `strict`/`strip`/`passthrough` not representable                 |
| array                                                             | `[T]` with item `!` from side analysis                                                             |
| homogeneous tuple                                                 | `[T!]` ⚠️ `tuple-length-lost`                                                                      |
| heterogeneous tuple                                               | `JSON` ⚠️ `tuple-as-json`                                                                          |
| record                                                            | `JSON` ⚠️ `record-as-json`                                                                         |
| union of objects                                                  | `union Name = A \| B` (null/undefined members absorbed into nullability, `never` dropped)          |
| scalar/mixed union                                                | `JSON` ⚠️ `scalar-union-as-json`                                                                   |
| union in input position                                           | `JSON` ⚠️ `input-union-as-json` (unions are output-only)                                           |
| discriminatedUnion                                                | object `union` (discriminator field carries through)                                               |
| object intersection                                               | merged type ⚠️ `intersection-merged`                                                               |
| non-object intersection                                           | `JSON` ⚠️ `intersection-as-json`                                                                   |
| optional/nullable                                                 | nullability (no `!`)                                                                               |
| required-but-nullable field                                       | nullable + ⚠️ `required-nullable` (unexpressible in GraphQL)                                       |
| default                                                           | input `= literal`                                                                                  |
| transform                                                         | input side exact; output `JSON` ⚠️ `transform-output-opaque`                                       |
| refine                                                            | transparent ⚠️ `refinement-dropped`                                                                |
| lazy                                                              | resolved (recursion by name)                                                                       |
| Query / Mutation / Subscription                                   | `type Query` / `type Mutation` / `type Subscription` (no `input`), `schema { query: ... }`         |
| federation type `@key` etc                                        | `type User @key(fields: "id") @shareable { ... }` / `extend type User { ... }` when `extends:true` |
| federation field `@shareable` etc                                 | `field: Type @shareable @requires(fields: "...")` etc, gated by `federation.enabled`               |

Warning codes: `transform-output-opaque`, `refinement-dropped`, `normalizer-dropped`, `tuple-length-lost`, `tuple-as-json`, `record-as-json`, `never-as-json`, `scalar-union-as-json`, `input-union-as-json`, `intersection-merged`, `intersection-as-json`, `nonserializable-default`, `name-sanitized`, `literal-fallback`, `required-nullable`, `root-kind-unsupported`, `duplicate-type`.
