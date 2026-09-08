# @minostack/openapi

> Convert `@minostack/schema` graphs to OpenAPI 3.1 and 3.0 Schema Objects and documents — every kind covered, approximations reported, nothing silently lost.

```ts
import { m } from "@minostack/schema";
import { oas31, document31 } from "@minostack/openapi";

const User = m.object({ id: m.string().uuid(), age: m.number().int().optional() });

oas31(User).schema;
// { type: "object", properties: { id: { type: "string", format: "uuid" }, age: { type: "integer" } }, required: ["id"] }

document31({ title: "API", version: "1.0.0" }, { User }).document;
// { openapi: "3.1.0", info: {...}, paths: {}, components: { schemas: { User: {...} } } }
```

## Rules

- **One engine, two lowerings.** `oas31` / `document31` emit JSON-Schema-compatible 3.1; `oas30` / `document30` lower to the 3.0 subset (`nullable`, boolean `exclusiveMinimum`, `enum` instead of `const`, no `prefixItems`/`propertyNames`).
- **Transforms emit the input side** (what the API receives over JSON). Response shapes with transforms need their own schema.
- **Required comes from undefined-acceptance**: optional/default/any/unknown fields are not required; nullable fields are required but nullable.
- **Recursion needs `document31`/`document30`** with the recursive schema registered as a named component (cycles become `$ref`s). Standalone `oas31`/`oas30` throw on cycles.
- **Shared nodes deduplicate**: the same schema object nested twice converts once and is `$ref`'d. Register shared/recursive schemas as named entries.
- Every conversion returns `{ schema, warnings }`. Warning codes are stable; messages are not.

## Enterprise builder (paths, components, webhooks)

`document31(info, schemas, options)` and `document30(info, schemas, options)` accept an enterprise `options` bag:

```ts
document31(
  { title: "Enterprise API", version: "2.1.0" },
  { User, Order, ErrorResponse },
  {
    servers: [{ url: "https://api.example.com/v1", description: "Production" }],
    tags: [{ name: "users", description: "User management" }],
    security: [{ bearerAuth: [] }],
    externalDocs: { url: "https://docs.example.com" },
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base", // 3.1 only
    paths: {
      "/users": {
        get: {
          operationId: "listUsers",
          parameters: [{ name: "page", in: "query", schema: m.number().int().min(1).default(1) }],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: PaginatedUsers } },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
          },
        },
        post: {
          requestBody: { required: true, content: { "application/json": { schema: CreateUser } } },
          responses: {
            "201": { description: "Created", content: { "application/json": { schema: User } } },
          },
        },
      },
      "/users/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: m.string().uuid() }],
        get: {
          responses: {
            "200": { description: "ok", content: { "application/json": { schema: User } } },
          },
        },
      },
    },
    webhooks: {
      // 3.1 only — warns and is omitted in 3.0
      orderCreated: {
        post: {
          requestBody: { content: { "application/json": { schema: Order } } },
          responses: { "200": { description: "ok" } },
        },
      },
    },
    components: {
      // schemas here merge with the second-arg `schemas` map; Schema instances become $ref'd
      responses: {
        NotFound: {
          description: "Not found",
          content: { "application/json": { schema: ErrorResponse } },
        },
      },
      parameters: {
        PageParam: { name: "page", in: "query", schema: m.number().int().min(1).default(1) },
      },
      requestBodies: {
        CreateUser: { content: { "application/json": { schema: CreateUser } } },
      },
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      headers: {
        "X-Request-Id": { description: "Request ID", schema: { type: "string", format: "uuid" } },
      },
      pathItems: {
        UserPath: {
          get: {
            responses: {
              "200": { description: "ok", content: { "application/json": { schema: User } } },
            },
          },
        },
      },
    },
  },
).document;
// { openapi:"3.1.0", info, servers, paths:{"/users":{...}}, webhooks:{...}, components:{ schemas, responses, parameters, requestBodies, securitySchemes, headers, pathItems }, security, tags, externalDocs }
```

- **`paths`** / **`components`** `schema` fields accept `Schema` instances (converted with the same `$ref` deduplication as `components.schemas`), raw `OasSchema`, or `{ $ref }`.
- **`webhooks`** and **`jsonSchemaDialect`** are 3.1-only: `document30` with them emits `webhooks-requires-3.1` / `jsonSchemaDialect-requires-3.1` warnings and omits the fields.
- **`servers`**, **`tags`**, **`security`**, **`externalDocs`** pass through; hostile keys (`__proto__`) are safe.
- Playground proof: `playground/src/practicals/enterprise.ts` builds a full Enterprise API (8 schemas, 7 path groups, 3 webhooks, 4 response/parameter/security components, 3 servers) and snapshots it byte-exact in `snapshots/enterprise.openapi.json`.

## Kind × version table (100/100: exact or warned)

| Kind                                                       | 3.1                                                                                                             | 3.0                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| string + min/max/length/regex/startsWith/endsWith/includes | `type` + `minLength`/`maxLength`/`pattern`                                                                      | same                                                                 |
| email/url/uuid/datetime                                    | `format: email`/`uri`/`uuid`/`date-time`                                                                        | same                                                                 |
| trim/toLowerCase/toUpperCase                               | ⚠️ `normalizer-dropped`                                                                                         | same                                                                 |
| number + bounds/multipleOf, int/safe → integer             | `minimum`/`maximum`, numeric `exclusiveMinimum/Maximum`                                                         | boolean `exclusiveMinimum/Maximum` + bound                           |
| finite                                                     | dropped (JSON numbers are finite)                                                                               | same                                                                 |
| bigint                                                     | `integer` + `int64`, safe bounds                                                                                | same; unsafe bounds ⚠️ `bigint-bound-omitted`                        |
| boolean                                                    | `boolean`                                                                                                       | same                                                                 |
| date                                                       | `string` + `date-time`                                                                                          | same                                                                 |
| literal                                                    | `const`                                                                                                         | `enum: [v]` (+ `type`); `null` → `enum: [null]`                      |
| literal(undefined), `undefined`                            | `{}` ⚠️ `undefined-literal`                                                                                     | same                                                                 |
| enum                                                       | `string` + `enum`                                                                                               | same                                                                 |
| null                                                       | `type: "null"`                                                                                                  | `enum: [null]`                                                       |
| any/unknown                                                | `{}`                                                                                                            | same                                                                 |
| never                                                      | `{ not: {} }`                                                                                                   | same                                                                 |
| object                                                     | `properties` + computed `required`; strip default, strict → `additionalProperties: false`, passthrough → `true` | same                                                                 |
| title/description/deprecated/examples                      | native (`examples` array)                                                                                       | `example` takes the first                                            |
| array + min/max/length                                     | `items` + `minItems`/`maxItems`                                                                                 | same                                                                 |
| tuple                                                      | `prefixItems` + exact length                                                                                    | `items: { anyOf }` + length ⚠️ `tuple-positions-lost`                |
| record                                                     | `additionalProperties` + `propertyNames`                                                                        | no `propertyNames` ⚠️ `property-names-dropped` (numeric keys always) |
| union                                                      | `anyOf`                                                                                                         | `anyOf` + null-partition to `nullable: true`                         |
| discriminatedUnion                                         | `oneOf` + `discriminator`; `mapping` to registered components in documents                                      | same                                                                 |
| intersection                                               | `allOf`                                                                                                         | same                                                                 |
| optional                                                   | transparent (drives `required`)                                                                                 | same                                                                 |
| nullable                                                   | `type: [..., "null"]`                                                                                           | `nullable: true` (`allOf` wrapper beside `$ref`)                     |
| default                                                    | `default` (JSON-serializable; Date → ISO, safe bigint → number) else ⚠️ `nonserializable-default`               | same                                                                 |
| transform                                                  | input side ⚠️ `transform-input-side`                                                                            | same                                                                 |
| refine                                                     | base type ⚠️ `refinement-dropped`                                                                               | same                                                                 |
| lazy                                                       | resolved (`$ref` in documents)                                                                                  | same                                                                 |

Warning codes: `transform-input-side`, `refinement-dropped`, `normalizer-dropped`, `bigint-bound-omitted`, `nonserializable-default`, `nonserializable-example`, `tuple-positions-lost`, `property-names-dropped`, `undefined-literal`, `webhooks-requires-3.1`, `jsonSchemaDialect-requires-3.1`.
