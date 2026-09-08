import { assert, describe, it } from "vitest";
import { m } from "@minostack/schema";
import { oas30 } from "../src/index.js";
import type { ConversionWarning } from "../src/index.js";

function codesOf(result: { warnings: ConversionWarning[] }): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("oas30 lowering", () => {
  it("uses nullable instead of type arrays", () => {
    assert.deepEqual(oas30(m.string().nullable()).schema, { type: "string", nullable: true });
    assert.deepEqual(oas30(m.string()).schema, { type: "string" });
  });

  it("lowers const to single enums", () => {
    assert.deepEqual(oas30(m.literal("a")).schema, { type: "string", enum: ["a"] });
    assert.deepEqual(oas30(m.literal(42)).schema, { type: "integer", enum: [42] });
    assert.deepEqual(oas30(m.literal(null)).schema, { enum: [null] });
  });

  it("lowers exclusive bounds to boolean modifiers", () => {
    assert.deepEqual(oas30(m.number().gt(1)).schema, {
      type: "number",
      minimum: 1,
      exclusiveMinimum: true,
    });
    assert.deepEqual(oas30(m.number().lt(1)).schema, {
      type: "number",
      maximum: 1,
      exclusiveMaximum: true,
    });
    assert.deepEqual(oas30(m.number().gte(1).lte(2)).schema, {
      type: "number",
      minimum: 1,
      maximum: 2,
    });
  });

  it("degrades tuples without prefixItems", () => {
    const result = oas30(m.tuple([m.string(), m.number()]));
    assert.deepEqual(result.schema, {
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
      minItems: 2,
      maxItems: 2,
    });
    assert.deepEqual(codesOf(result), ["tuple-positions-lost"]);
  });

  it("drops propertyNames", () => {
    const result = oas30(m.record(m.enum(["a", "b"]), m.number()));
    assert.deepEqual(result.schema, { type: "object", additionalProperties: { type: "number" } });
    assert.deepEqual(codesOf(result), ["property-names-dropped"]);
    assert.deepEqual(oas30(m.record(m.number())).schema, {
      type: "object",
      additionalProperties: { type: "number" },
    });
  });

  it("partitions null out of unions", () => {
    assert.deepEqual(oas30(m.union([m.string(), m.null()])).schema, {
      type: "string",
      nullable: true,
    });
    assert.deepEqual(oas30(m.union([m.string(), m.number(), m.null()])).schema, {
      anyOf: [{ type: "string" }, { type: "number" }],
      nullable: true,
    });
    assert.deepEqual(oas30(m.union([m.string(), m.number()])).schema, {
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("maps edge kinds without boolean schemas", () => {
    assert.deepEqual(oas30(m.any()).schema, {});
    assert.deepEqual(oas30(m.unknown()).schema, {});
    assert.deepEqual(oas30(m.never()).schema, { not: {} });
    assert.deepEqual(oas30(m.null()).schema, { enum: [null] });
    const undef = oas30(m.undefined());
    assert.deepEqual(undef.schema, {});
    assert.deepEqual(codesOf(undef), ["undefined-literal"]);
  });

  it("uses singular example", () => {
    const result = oas30(m.string().meta({ examples: ["a", "b"] }));
    assert.deepEqual(result.schema, { type: "string", example: "a" });
  });

  it("shares objects, metadata, and wrappers with 3.1", () => {
    assert.deepEqual(
      oas30(m.object({ a: m.string(), b: m.number().optional() }).describe("O").strict()).schema,
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a"],
        additionalProperties: false,
        description: "O",
      },
    );
    const disc = oas30(m.discriminatedUnion("type", [m.object({ type: m.literal("a") })]));
    assert.deepEqual(disc.schema.discriminator, { propertyName: "type" });
  });
});
