# @minostack/schema

> A TypeScript-first, ESM-native, runtime-agnostic schema and validation library with static inference, structured runtime validation, immutable composition, and an extensible metadata foundation.

```ts
import { m } from "@minostack/schema";

const User = m.object({
  name: m.string().min(2),
  age: m.number().int().optional(),
});

type User = m.infer<typeof User>;

const result = User.safeParse(input);
```

## Why

Define a data contract once and use it for runtime validation, static TypeScript
inference, metadata, and future projections — with no silent coercion and no
hidden transforms. What you declare is what runs.

## Usage

```ts
import { m } from "@minostack/schema";

const User = m.object({
  id: m.string().uuid(),
  email: m.string().email(),
  age: m.number().int().min(0).optional(),
  role: m.enum(["admin", "member"]),
});

type User = m.infer<typeof User>; // { id: string; email: string; age?: number; role: "admin" | "member" }

User.parse(input); // returns User, throws ValidationError on failure
const result = User.safeParse(input); // { success: true; data } | { success: false; error }
if (!result.success) {
  console.log(result.error.issues); // [{ code: "invalid_type", path: ["age"], message, ... }]
}
```

Schemas are immutable: every modifier returns a new schema. Objects strip
unknown keys by default (`.passthrough()` / `.strict()` opt out). Refinements
and transforms are explicit:

```ts
const Name = m.string().trim().min(1);
const Slug = m.string().refine((value) => !value.includes(" "), { message: "No spaces" });
const Count = m.string().transform((value) => value.length); // input string, output number
```

Standard Schema interop is built in: every schema exposes `~standard.validate`.

## Develop

```bash
pnpm --filter @minostack/schema test
pnpm --filter @minostack/schema typecheck
pnpm --filter @minostack/schema build
```

## Scope

v0.1: `string number boolean bigint date literal enum null undefined any unknown never
object array tuple record union discriminatedUnion intersection optional nullable
default lazy` + `transform refine` + `parse` / `safeParse` + structured
`ValidationError` / `ValidationIssue` + `m.infer` / `m.input` / `m.output` +
metadata (`describe` / `meta`) + facets + Standard Schema bridge.

Deferred: async validation, coercion, compiled validators, JSON Schema / OpenAPI /
GraphQL generation, serialization, codegen, CLI, framework adapters.
