import { assert, describe, it } from "vitest";
import { m } from "@minostack/schema";
import { oas31 } from "../src/index.js";
import type { ConversionWarning } from "../src/index.js";

function converted(schema: Parameters<typeof oas31>[0]): ReturnType<typeof oas31> {
  return oas31(schema);
}

function codesOf(result: { warnings: ConversionWarning[] }): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("oas31 primitives", () => {
  it("maps strings with checks", () => {
    assert.deepEqual(converted(m.string().min(2).max(4).email()).schema, {
      type: "string",
      minLength: 2,
      maxLength: 4,
      format: "email",
    });
    assert.deepEqual(converted(m.string().regex(/^a+$/)).schema, {
      type: "string",
      pattern: "^a+$",
    });
    assert.deepEqual(converted(m.string().startsWith("ab")).schema, {
      type: "string",
      pattern: "^ab",
    });
    assert.deepEqual(converted(m.string().length(2)).schema, {
      type: "string",
      minLength: 2,
      maxLength: 2,
    });
    assert.deepEqual(converted(m.string().url()).schema, { type: "string", format: "uri" });
    assert.deepEqual(converted(m.string().uuid()).schema, { type: "string", format: "uuid" });
    assert.deepEqual(converted(m.string().datetime()).schema, {
      type: "string",
      format: "date-time",
    });
  });

  it("warns on normalizers", () => {
    const result = converted(m.string().trim().toLowerCase());
    assert.deepEqual(result.schema, { type: "string" });
    assert.deepEqual(codesOf(result), ["normalizer-dropped", "normalizer-dropped"]);
  });

  it("maps numbers with bounds", () => {
    assert.deepEqual(converted(m.number().int().gte(1).lt(10).multipleOf(2)).schema, {
      type: "integer",
      minimum: 1,
      exclusiveMaximum: 10,
      multipleOf: 2,
    });
    assert.deepEqual(converted(m.number().gt(1)).schema, { type: "number", exclusiveMinimum: 1 });
    assert.deepEqual(converted(m.number()).schema, { type: "number" });
  });

  it("maps bigint with safe bounds", () => {
    assert.deepEqual(converted(m.bigint().min(0n)).schema, {
      type: "integer",
      format: "int64",
      minimum: 0,
    });
    const unsafe = converted(m.bigint().min(2n ** 100n));
    assert.deepEqual(unsafe.schema, { type: "integer", format: "int64" });
    assert.deepEqual(codesOf(unsafe), ["bigint-bound-omitted"]);
  });

  it("maps scalars, literals, and edge kinds", () => {
    assert.deepEqual(converted(m.boolean()).schema, { type: "boolean" });
    assert.deepEqual(converted(m.date()).schema, { type: "string", format: "date-time" });
    assert.deepEqual(converted(m.literal("a")).schema, { const: "a" });
    assert.deepEqual(converted(m.literal(42)).schema, { const: 42 });
    assert.deepEqual(converted(m.literal(null)).schema, { const: null });
    assert.deepEqual(converted(m.enum(["a", "b"])).schema, { type: "string", enum: ["a", "b"] });
    assert.deepEqual(converted(m.null()).schema, { type: "null" });
    assert.deepEqual(converted(m.any()).schema, {});
    assert.deepEqual(converted(m.unknown()).schema, {});
    assert.deepEqual(converted(m.never()).schema, { not: {} });
    const undef = converted(m.literal(undefined));
    assert.deepEqual(undef.schema, {});
    assert.deepEqual(codesOf(undef), ["undefined-literal"]);
  });
});

describe("oas31 objects", () => {
  it("computes required from undefined-acceptance", () => {
    const result = converted(
      m.object({
        a: m.string(),
        b: m.string().optional(),
        c: m.string().default("x"),
        d: m.unknown(),
        e: m.string().nullable(),
      }),
    );
    assert.deepEqual(result.schema, {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string", default: "x" },
        d: {},
        e: { type: ["string", "null"] },
      },
      required: ["a", "e"],
    });
    assert.deepEqual(result.warnings, []);
  });

  it("maps unknown-key policies", () => {
    assert.deepEqual(converted(m.object({})).schema, { type: "object", properties: {} });
    assert.deepEqual(converted(m.object({}).strict()).schema.additionalProperties, false);
    assert.deepEqual(converted(m.object({}).passthrough()).schema.additionalProperties, true);
  });

  it("maps metadata", () => {
    const result = converted(
      m
        .object({ a: m.string().describe("Field A") })
        .describe("An object")
        .meta({ title: "Obj", examples: [{ a: "x" }], deprecated: true }),
    );
    assert.deepEqual(result.schema, {
      type: "object",
      properties: { a: { type: "string", description: "Field A" } },
      required: ["a"],
      title: "Obj",
      description: "An object",
      examples: [{ a: "x" }],
      deprecated: true,
    });
  });

  it("reports nested paths precisely", () => {
    const result = converted(m.object({ users: m.array(m.object({ email: m.number() })) }));
    assert.deepEqual(result.schema, {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: { type: "object", properties: { email: { type: "number" } }, required: ["email"] },
        },
      },
      required: ["users"],
    });
  });
});

describe("oas31 collections", () => {
  it("maps arrays and tuples", () => {
    assert.deepEqual(converted(m.array(m.string()).min(1).max(2)).schema, {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 2,
    });
    assert.deepEqual(converted(m.tuple([m.string(), m.number()])).schema, {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      minItems: 2,
      maxItems: 2,
    });
  });

  it("maps records with propertyNames", () => {
    assert.deepEqual(converted(m.record(m.number())).schema, {
      type: "object",
      additionalProperties: { type: "number" },
    });
    assert.deepEqual(converted(m.record(m.enum(["a", "b"]), m.number())).schema, {
      type: "object",
      additionalProperties: { type: "number" },
      propertyNames: { type: "string", enum: ["a", "b"] },
    });
    const numeric = converted(m.record(m.number(), m.string()));
    assert.deepEqual(numeric.schema, { type: "object", additionalProperties: { type: "string" } });
    assert.deepEqual(codesOf(numeric), ["property-names-dropped"]);
  });
});

describe("oas31 composition", () => {
  it("maps unions, discriminated unions, and intersections", () => {
    assert.deepEqual(converted(m.union([m.string(), m.number()])).schema, {
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    const disc = converted(
      m.discriminatedUnion("type", {
        a: m.object({ type: m.literal("a"), x: m.string() }),
        b: m.object({ type: m.literal("b") }),
      }),
    );
    assert.deepEqual(disc.schema, {
      oneOf: [
        {
          type: "object",
          properties: { type: { const: "a" }, x: { type: "string" } },
          required: ["type", "x"],
        },
        { type: "object", properties: { type: { const: "b" } }, required: ["type"] },
      ],
      discriminator: { propertyName: "type" },
    });
    assert.deepEqual(
      converted(m.intersection(m.object({ a: m.string() }), m.object({ b: m.number() }))).schema,
      {
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
        ],
      },
    );
  });

  it("handles wrappers with input-side transforms", () => {
    assert.deepEqual(converted(m.string().optional()).schema, { type: "string" });
    assert.deepEqual(converted(m.string().nullable()).schema, { type: ["string", "null"] });
    assert.deepEqual(converted(m.string().default("x")).schema, { type: "string", default: "x" });
    const transform = converted(m.string().transform((value) => value.length));
    assert.deepEqual(transform.schema, { type: "string" });
    assert.deepEqual(codesOf(transform), ["transform-input-side"]);
    const refine = converted(m.string().refine((value) => value.length > 0));
    assert.deepEqual(refine.schema, { type: "string" });
    assert.deepEqual(codesOf(refine), ["refinement-dropped"]);
    const badDefault = converted(m.string().default((() => "x") as unknown as string));
    assert.deepEqual(badDefault.schema, { type: "string" });
    assert.deepEqual(codesOf(badDefault), ["nonserializable-default"]);
  });
});
