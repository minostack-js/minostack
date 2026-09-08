Below is the **focused blueprint document for `@minostack/schema` only**—deliberately leaving OpenAPI, GraphQL, HTTP, and framework integration as future extension possibilities rather than current scope.

# MinoStack Schema

## Blueprint & Development Specification — v0.1

> `@minostack/schema`
>
> An ESM-native, runtime-agnostic, zero-runtime-dependency schema and validation library for TypeScript.

---

# 1. Project Definition

## 1.1 Package

```text
@minostack/schema
```

Repository:

```text
minostack-js
```

The first MinoStack package is a standalone schema system.

It is NOT currently a framework.

It is NOT an HTTP library.

It is NOT an OpenAPI library.

It is NOT a GraphQL library.

Its responsibility is:

```text
Schema Definition
        ↓
Runtime Validation
        ↓
Type Inference
        ↓
Metadata / Extension Foundation
```

Future packages or integrations may consume the schema system.

---

# 2. Core Vision

MinoStack Schema should allow developers to define a data contract once and use that contract throughout a TypeScript application.

Example:

```ts
import { m } from "@minostack/schema";

const User = m.object({
  id: m.string().uuid(),
  name: m.string().min(2).max(100),
  email: m.string().email(),
  age: m.number().int().optional(),
});
```

The same definition provides:

```text
Runtime validation
      +
Static TypeScript inference
      +
Metadata
      +
Future projections/extensions
```

Example:

```ts
type User = m.infer<typeof User>;
```

And:

```ts
const result = User.safeParse(value);
```

The long-term goal is:

```text
                  MinoStack Schema
                         │
             ┌───────────┼───────────┐
             │           │           │
             ▼           ▼           ▼
          TypeScript  Validation  Metadata
                                      │
                               Future Extensions
```

---

# 3. Design Philosophy

## 3.1 TypeScript-first

The library exists primarily for TypeScript.

The developer experience should feel natural to TypeScript developerm.

Avoid APIs that require:

```text
verbose generic annotations
manual type duplication
schema/type synchronization
code generation for basic inference
```

Preferred:

```ts
const User = m.object({
  name: m.string(),
});

type User = m.infer<typeof User>;
```

---

## 3.2 Runtime-first correctness

TypeScript types disappear at runtime.

Therefore the schema must remain executable at runtime.

A schema is not simply a type declaration.

It is:

```text
type information
+
runtime behavior
+
constraints
+
metadata
```

---

## 3.3 Immutable schemas

Schema instances must be immutable.

This:

```ts
const base = m.string();

const username = base.min(3);
const password = base.min(8);
```

must not mutate `base`.

Conceptually:

```text
base
 │
 ├── username
 │
 └── password
```

Every modifier produces a new schema.

This enables:

```text
safe reuse
composition
predictable metadata
caching
memoization
future compilation
```

---

## 3.4 Runtime agnostic

The core package must not depend on a specific JavaScript runtime.

Supported:

```text
Node.js >= 22
Bun
Deno
```

The package should use portable ECMAScript/TypeScript featurem.

Avoid unnecessary dependencies on:

```text
node:fs
node:path
node:crypto
process
Buffer
Node streams
Bun APIs
Deno APIs
```

unless isolated into optional adapters in future packagem.

---

## 3.5 ESM-native

The package is ESM-only.

No CommonJS compatibility layer.

No dual package complexity.

Avoid:

```text
require()
module.exports
.cjs builds
```

The package should publish modern ESM.

Example:

```json
{
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  }
}
```

---

## 3.6 Zero runtime dependencies

Target:

```text
@minostack/schema
└── 0 runtime dependencies
```

Development dependencies are allowed.

Runtime dependencies are not desirable for the core.

This keeps:

```text
bundle size small
startup cost low
runtime portability high
dependency surface predictable
```

---

# 4. What Is a Schema?

A MinoStack schema represents:

```text
Shape
+
Constraints
+
Composition
+
Transformation
+
Metadata
+
Validation behavior
```

Conceptual model:

```ts
interface Schema<TOutput, TInput = TOutput> {
  readonly kind: SchemaKind;

  parse(input: TInput): TOutput;

  safeParse(
    input: TInput,
  ): { success: true; data: TOutput } | { success: false; error: ValidationError };
}
```

The actual public interface may evolve.

The important architectural rule is:

> The schema must be an executable, immutable value object.

---

# 5. Public Entry Point

Preferred developer API:

```ts
import { m } from "@minostack/schema";
```

Primary namespace:

```text
s
```

Example:

```ts
m.string()
m.number()
m.boolean()
m.object(...)
m.array(...)
m.union(...)
```

The API should remain discoverable from the `s` namespace.

---

# 6. Primitive Schemas

Initial primitives:

```text
string
number
boolean
bigint
date
symbol
unknown
any
never
undefined
null
```

Potentially:

```text
void
```

should not be prioritized unless there is a clear use case.

---

# 7. Literal Schemas

Support exact valuem.

Examples:

```ts
m.literal("admin");

m.literal(42);

m.literal(true);

m.null();
```

Literal schemas are important for:

```text
discriminated unions
configuration schemas
protocol values
enum-like contracts
```

---

# 8. Enum Schema

Provide a simple ergonomic enum API.

Example:

```ts
const Role = m.enum(["admin", "member", "guest"]);
```

Inference:

```ts
type Role = m.infer<typeof Role>;
// 'admin' | 'member' | 'guest'
```

Avoid coupling the API to TypeScript `enum`.

String literal arrays should be the primary model.

---

# 9. String Schema

Base:

```ts
m.string();
```

Common constraints:

```ts
.min(length)
.max(length)
.length(length)

.email()
.url()
.uuid()

.regex(pattern)

.startsWith(value)
.endsWith(value)
.includes(value)

.trim()
.toLowerCase()
.toUpperCase()
```

The exact API should be finalized after implementation experimentm.

Do not blindly clone another library's API.

---

# 10. Number Schema

Base:

```ts
m.number();
```

Constraints:

```text
min
max
gt
gte
lt
lte
multipleOf
finite
safe
integer
```

Example:

```ts
m.number().int().min(0).max(100);
```

---

# 11. Boolean

```ts
m.boolean();
```

Keep the primitive simple.

Coercion should be a separate semantic operation rather than implicit behavior.

---

# 12. BigInt

```ts
m.bigint();
```

Constraints:

```text
min
max
gt
gte
lt
lte
multipleOf
```

---

# 13. Date

```ts
m.date();
```

The schema should validate actual JavaScript `Date` valuem.

String date representations should remain string schemas with explicit constraintm.

For example:

```ts
m.string().datetime();
```

rather than silently treating strings as datem.

---

# 14. Arrays

```ts
m.array(m.string());
```

Constraints:

```text
min
max
length
```

Example:

```ts
const Tags = m.array(m.string().min(1)).max(10);
```

---

# 15. Tuples

```ts
const Coordinates = m.tuple([m.number(), m.number()]);
```

Optional tuple/rest support can be added later.

---

# 16. Objects

Primary complex type:

```ts
const User = m.object({
  id: m.string().uuid(),
  name: m.string(),
  age: m.number().optional(),
});
```

Objects must define clear unknown-key behavior.

Initial policy should be explicitly chosen rather than accidentally inherited from implementation detailm.

Candidate modes:

```text
strip
passthrough
strict
```

Preferred API:

```ts
m.object({...})
  .strip()

m.object({...})
  .passthrough()

m.object({...})
  .strict()
```

A sensible default should be documented and tested thoroughly.

---

# 17. Object Utilities

The object API should eventually support:

```text
pick
omit
partial
required
extend
merge
```

Example:

```ts
const User = m.object({
  id: m.string(),
  name: m.string(),
  email: m.string(),
});

const UserUpdate = User.partial();

const PublicUser = User.pick({
  id: true,
  name: true,
});
```

These operations must preserve schema metadata where logically possible.

---

# 18. Record

```ts
m.record(m.string());
```

or:

```ts
m.record(m.string(), m.number());
```

depending on the final API.

Record semantics must remain distinct from object schemam.

---

# 19. Union

Basic union:

```ts
m.union([m.string(), m.number()]);
```

Result:

```text
string | number
```

Validation behavior should preserve useful error information.

---

# 20. Discriminated Union

Important for TypeScript applicationm.

Example:

```ts
const Result = m.discriminatedUnion("type", {
  success: m.object({
    type: m.literal("success"),
    value: m.string(),
  }),

  error: m.object({
    type: m.literal("error"),
    message: m.string(),
  }),
});
```

The exact ergonomic API can evolve.

The underlying schema graph must understand discriminators as a semantic concept.

---

# 21. Intersection

```ts
m.intersection(SchemaA, SchemaB);
```

Should support:

```text
A & B
```

Validation semantics need special care for object conflictm.

Example:

```text
A.name -> string
B.name -> number
```

must produce a deterministic failure rather than undefined behavior.

---

# 22. Optional

```ts
m.string().optional();
```

Meaning:

```text
string | undefined
```

For object properties:

```ts
{
  nickname?: string
}
```

must be correctly represented in inferred TypeScript typem.

---

# 23. Nullable

```ts
m.string().nullable();
```

Meaning:

```text
string | null
```

Optional and nullable are distinct:

```text
optional ≠ nullable
```

---

# 24. Default Values

Potential API:

```ts
m.string().default("guest");
```

This introduces an important distinction between input and output.

Example:

```text
Input:
string | undefined

Output:
string
```

Therefore the type system must support:

```ts
m.input<typeof Schema>;
m.output<typeof Schema>;
```

even if `m.infer` remains the common shorthand.

---

# 25. Transformations

Transforms must be explicit.

Example:

```ts
const UserId = m.string().transform((value) => value.toLowerCase());
```

A transformed schema has:

```text
Input type
Output type
```

Example:

```text
Input  = string
Output = string
```

For:

```ts
const DateValue = m
  .string()
  .datetime()
  .transform((value) => new Date(value));
```

we have:

```text
Input  = string
Output = Date
```

This distinction is foundational.

---

# 26. Coercion

Coercion should be explicit.

Do not silently convert input just because it "looks compatible."

Bad:

```text
number schema accepts "42" automatically
```

Preferred:

```ts
m.coerce.number();
```

or an equivalent explicit API.

The exact syntax can be decided later.

Principle:

> Validation and coercion must be distinguishable.

---

# 27. Refinement

Allow custom runtime predicatem.

Example:

```ts
m.string().refine((value) => value !== "forbidden");
```

Potential support for custom messages:

```ts
m.string().refine((value) => value !== "forbidden", {
  message: "This value is not allowed",
});
```

Refinements are runtime semanticm.

They must not pretend to be statically representable constraints when they are not.

---

# 28. Async Validation

Do not make the core async by default.

But the schema model should permit future async validation.

Potential APIs:

```text
parse
safeParse

parseAsync
safeParseAsync
```

Async functionality may become necessary for:

```text
database-backed validation
external uniqueness checks
custom asynchronous refinements
```

Do not build this before synchronous validation is stable.

---

# 29. Lazy / Recursive Schemas

Support recursion.

Example:

```ts
const Node = m.lazy(() =>
  m.object({
    value: m.string(),
    children: m.array(Node),
  }),
);
```

This requires the schema architecture to support graph-like references instead of assuming a tree.

---

# 30. Metadata

Metadata must be a first-class concept.

Example:

```ts
const User = m.object({
  name: m.string().describe("Display name"),
});
```

Initial generic metadata:

```text
id
title
description
examples
deprecated
```

Potential:

```text
default
readOnly
writeOnly
```

should only be added when semantics are clear.

Metadata must not affect validation unless explicitly defined to do so.

---

# 31. Extension / Facet Architecture

The core should provide an extension point without committing to specific consumerm.

Concept:

```ts
schema.meta(...)
schema.facet(...)
```

A facet is namespaced metadata owned by an extension.

Conceptual example:

```ts
schema.facet('example-extension', {
  ...
})
```

The core should not contain OpenAPI or GraphQL assumptionm.

Future consumers could attach their own facetm.

The architecture should allow:

```text
MinoStack Schema
       │
       ├── core metadata
       │
       └── extension facets
             ├── future OpenAPI
             ├── future GraphQL
             ├── future serialization
             └── user extensions
```

This is an architectural provision, not a v0.1 commitment to any particular integration.

---

# 32. Error Model

Errors must be structured.

Example:

```ts
interface ValidationIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;

  readonly expected?: unknown;
  readonly received?: unknown;
}
```

Example result:

```ts
{
  success: false,
  error: ValidationError
}
```

Error object:

```ts
class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
}
```

---

# 33. Error Paths

Nested validation must preserve precise pathm.

Example input:

```ts
{
  users: [
    {
      email: 123,
    },
  ];
}
```

Issue path:

```text
users
0
email
```

Conceptually:

```ts
path: ["users", 0, "email"];
```

This is important for:

```text
API error responses
forms
logging
testing
developer debugging
```

---

# 34. Error Codes

Use stable machine-readable codem.

Examples:

```text
invalid_type
invalid_literal
invalid_string
invalid_number
too_small
too_big
invalid_format
invalid_union
invalid_value
custom
```

The exact code taxonomy should be designed centrally.

Do not let individual validators invent inconsistent error formatm.

---

# 35. Localization

Validation issues should remain machine-readable.

Human-readable messages should not be the only source of truth.

Future localization should be possible without changing validation logic.

Potential architecture:

```text
ValidationIssue
      │
      ├── code
      ├── params
      └── path
              ↓
        Message Formatter
```

This allows custom messages/locales later.

---

# 36. Type Inference

Primary:

```ts
type User = m.infer<typeof UserSchema>;
```

Explicit variants:

```ts
type Input = m.input<typeof Schema>;
type Output = m.output<typeof Schema>;
```

This should be designed early even if simple schemas initially produce:

```text
Input = Output
```

---

# 37. Type Inference Requirements

Inference must correctly preserve:

```text
optional properties
nullable values
literal values
unions
intersections
arrays
tuples
records
defaults
transform input/output
recursive types
readonly behavior if eventually supported
```

Type-level correctness is as important as runtime correctnesm.

---

# 38. Schema Composition Model

Every schema operation should produce another schema.

Example:

```text
string
  ↓
min
  ↓
regex
  ↓
optional
  ↓
transform
```

Conceptually:

```text
SchemaNode
   │
   ├── base semantics
   ├── constraints
   ├── wrappers
   ├── metadata
   └── extension facets
```

Avoid implementing every method as unrelated runtime logic.

---

# 39. Internal Schema Representation

The public API should be backed by a canonical internal representation.

Conceptually:

```ts
interface SchemaNode {
  readonly kind: SchemaKind;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}
```

For composite schemas:

```text
object
  └── fields
       ├── id → StringSchema
       ├── name → StringSchema
       └── age → Optional(NumberSchema)
```

For union:

```text
Union
 ├── StringSchema
 └── NumberSchema
```

The exact internal structures remain implementation detailm.

---

# 40. Schema Kinds

Possible internal kinds:

```text
any
unknown
never

string
number
bigint
boolean
symbol
date
literal
enum

object
array
tuple
record

union
intersection

optional
nullable

default
transform
refinement

lazy
custom
```

Not every kind must necessarily be publicly exposed.

---

# 41. Runtime Validation Architecture

Initial implementation should use an interpreter.

Conceptual flow:

```text
schema.parse(input)
       │
       ▼
validate(schemaNode, input)
       │
       ├── primitive validator
       ├── object validator
       ├── array validator
       ├── union validator
       └── wrapper validator
       │
       ▼
ValidationResult
```

Do not introduce generated validator functions in v0.1 unless profiling demonstrates the need.

---

# 42. Future Compilation

The architecture should permit:

```ts
const validate = Schema.compile();
```

later.

Possible future architecture:

```text
Canonical Schema Graph
        ↓
Validator Compiler
        ↓
Optimized Validator
```

This may provide significant performance improvements but should not complicate the initial implementation.

---

# 43. Parsing vs Validation

The terminology should remain precise.

Validation answers:

```text
"Is this value valid?"
```

Parsing may also:

```text
transform
coerce
apply defaults
```

Therefore the API should clearly distinguish:

```text
validation
transformation
coercion
```

---

# 44. Serialization

Do not make serialization part of the first package.

Schema validation may eventually inform serializers, but:

```text
validation ≠ serialization
```

Keep the architecture open without implementing serialization in v0.1.

---

# 45. JSON Schema / OpenAPI / GraphQL

## Current status

NOT part of the v0.1 product commitment.

The schema model should merely avoid preventing future projection.

Do not design the core API around:

```text
OpenAPI-first semantics
GraphQL-first semantics
JSON Schema-only semantics
```

Those systems have different type capabilities and constraintm.

The canonical MinoStack schema should remain independent.

---

# 46. Standard Schema Interoperability

Investigate compatibility with Standard Schema.

Target concept:

```text
MinoStack Schema
       ↓
Standard Schema interface
```

This should be evaluated early because it can improve interoperability with the wider TypeScript ecosystem.

Do not make external interoperability standards dictate the internal architecture.

---

# 47. Public API Stability

Keep the initial public surface intentionally small.

Preferred:

```ts
import { s, Schema, ValidationError, ValidationIssue } from "@minostack/schema";
```

Potential type helpers:

```ts
infer;
input;
output;
```

Avoid exporting internal classes unless necessary.

---

# 48. Suggested Package Structure

```text
packages/
└── schema/
    ├── src/
    │   ├── index.ts
    │   │
    │   ├── schema/
    │   │   ├── schema.ts
    │   │   ├── kindm.ts
    │   │   ├── metadata.ts
    │   │   ├── facetm.ts
    │   │   └── typem.ts
    │   │
    │   ├── primitives/
    │   │   ├── string.ts
    │   │   ├── number.ts
    │   │   ├── boolean.ts
    │   │   ├── bigint.ts
    │   │   ├── date.ts
    │   │   ├── literal.ts
    │   │   └── unknown.ts
    │   │
    │   ├── composites/
    │   │   ├── object.ts
    │   │   ├── array.ts
    │   │   ├── tuple.ts
    │   │   ├── record.ts
    │   │   ├── union.ts
    │   │   ├── intersection.ts
    │   │   └── lazy.ts
    │   │
    │   ├── modifiers/
    │   │   ├── optional.ts
    │   │   ├── nullable.ts
    │   │   ├── default.ts
    │   │   ├── transform.ts
    │   │   └── refine.ts
    │   │
    │   └── validation/
    │       ├── validate.ts
    │       ├── issuem.ts
    │       └── error.ts
    │
    ├── test/
    ├── package.json
    └── tsconfig.json
```

---

# 49. Testing Strategy

Testing must be divided into:

```text
Runtime tests
Type-level tests
Composition tests
Error tests
Cross-runtime tests
```

---

# 50. Runtime Test Examples

Every schema should test:

```text
valid values
invalid values
edge cases
nested values
metadata behavior
composition
```

Example:

```ts
expect(m.string().parse("hello")).toBe("hello");
```

and:

```ts
expect(m.string().safeParse(123).success).toBe(false);
```

---

# 51. Type-Level Tests

Use compile-time assertionm.

Test:

```text
infer
input
output
optional
nullable
union
intersection
transform
recursive schemas
```

A runtime test passing does not guarantee correct TypeScript inference.

Both dimensions must be tested.

---

# 52. Cross-Runtime Testing

The package should be tested on:

```text
Node.js >= 22
Bun
Deno
```

No runtime-specific behavior should be accidentally introduced.

Use a portable test suite wherever practical.

---

# 53. Performance Testing

Performance matters, but benchmarks must be honest.

Measure:

```text
simple primitive validation
object validation
nested object validation
large arrays
union validation
deep schemas
schema creation
repeated parsing
```

Compare:

```text
cold execution
repeated execution
```

Do not optimize based on synthetic microbenchmarks alone.

---

# 54. Bundle Size

Track:

```text
uncompressed size
minified size
gzip
brotli
```

Do not allow unnecessary dependencies to creep into the core.

---

# 55. Tree Shaking

The API should allow bundlers to eliminate unused functionality.

Avoid a giant monolithic runtime registry if it prevents effective tree shaking.

Prefer modular implementation beneath a simple public API.

---

# 56. Documentation Structure

README should immediately answer:

```text
What is MinoStack Schema?
Why does it exist?
How do I define a schema?
How do I infer a type?
How do I validate input?
```

Basic example should fit in a few lines:

```ts
import { m } from "@minostack/schema";

const User = m.object({
  name: m.string(),
  age: m.number().int(),
});

type User = m.infer<typeof User>;

const result = User.safeParse(input);
```

Do not lead with a giant feature matrix.

---

# 57. API Naming Rules

Prefer obvious namem.

Use:

```text
string
number
object
array
optional
nullable
union
intersection
```

Avoid clever naming.

MinoStack is a developer infrastructure project; developers should be able to predict the API.

---

# 58. Error Handling Rule

Never silently accept invalid data.

Avoid ambiguous coercion.

Avoid hidden transformationm.

Every data-changing operation should be explicit.

Principle:

```text
Explicit > magical
Predictable > clever
Composable > convenient
```

---

# 59. Extension Rules

Future extensions must not require modifying the core schema semanticm.

An extension may:

```text
read schema nodes
read metadata
read facets
attach metadata/facets
project schemas
```

But should not be allowed to arbitrarily mutate existing schema state.

Schemas remain immutable.

---

# 60. v0.1 Feature Set

## Must Have

```text
ESM-only
runtime agnostic
zero runtime dependencies

string
number
boolean
bigint
date
literal
enum

object
array
tuple
record

union
intersection

optional
nullable

lazy

parse
safeParse

structured ValidationError
structured ValidationIssue

Type inference

metadata foundation

immutable schemas
```

## Strongly Recommended

```text
transform
refine

input/output type distinction

object utilities

Standard Schema compatibility investigation
```

## Defer

```text
async validation
coercion
compiled validators
JSON Schema generation
OpenAPI generation
GraphQL generation
serialization
code generation
CLI
framework adapters
```

---

# 61. v0.2 Candidates

After v0.1 proves the architecture:

```text
coercion
async validation
schema registries
more string formats
better refinement APIs
compiled validation
improved error formatting
interop improvements
```

Do not promise these until the v0.1 architecture demonstrates they fit naturally.

---

# 62. Definition of Done for v0.1

The package is ready when:

```text
[ ] ESM-only distribution works
[ ] Node >= 22 works
[ ] Bun works
[ ] Deno works

[ ] zero runtime dependencies

[ ] primitives are stable
[ ] object schemas are stable
[ ] composition works
[ ] recursive schemas work

[ ] runtime validation is deterministic
[ ] errors have stable structured paths/codes

[ ] infer works
[ ] input/output inference works where applicable

[ ] schemas are immutable

[ ] metadata architecture exists
[ ] extension/facet mechanism exists without coupling to a
    particular external ecosystem

[ ] runtime tests pass
[ ] type-level tests pass
[ ] cross-runtime tests pass

[ ] README contains practical examples
[ ] API exports are intentionally small
```

---

# 63. Guiding Architecture

The entire package should reduce to this conceptual model:

```text
                    ┌──────────────────────┐
                    │   Schema Definition  │
                    └──────────┬───────────┘
                               │
                               ▼
                  ┌────────────────────────┐
                  │ Canonical Schema Graph │
                  └───────────┬────────────┘
                              │
                 ┌────────────┼────────────┐
                 │            │            │
                 ▼            ▼            ▼
            Type System   Validation   Metadata
                 │            │            │
                 ▼            ▼            ▼
             TypeScript   Runtime     Extensions
```

The canonical schema graph is the heart of MinoStack Schema.

Everything else should build around it.

---

# 64. Product Statement

MinoStack Schema is:

> A TypeScript-first, ESM-native, runtime-agnostic schema and validation library with static inference, structured runtime validation, immutable composition, and an extensible metadata foundation.

The first version should resist becoming more than that.

The strength of the package should come from getting the schema model exceptionally right.

---

# 65. Final Design Constraint

Before adding a feature, ask:

```text
Does this improve the canonical schema model,
runtime validation,
TypeScript inference,
composition,
or extensibility?
```

If not:

```text
Do not add it to @minostack/schema.
```

MinoStack's surrounding ecosystem can grow later.

The first package should be small enough to understand completely,
but strong enough to become the foundation for everything built on top of it.

```

```
