import { assert, describe, it } from "vitest";
import { m } from "@minostack/schema";
import type { Schema } from "@minostack/schema";
import { document30, document31, oas30, oas31 } from "../src/index.js";
import type { ConversionWarning } from "../src/index.js";

function codesOf(result: { warnings: ConversionWarning[] }): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("oas edges: numbers and bigints", () => {
  it("maps min/max aliases", () => {
    assert.deepEqual(oas31(m.number().min(1).max(2)).schema, {
      type: "number",
      minimum: 1,
      maximum: 2,
    });
    assert.deepEqual(oas30(m.number().min(1).max(2)).schema, {
      type: "number",
      minimum: 1,
      maximum: 2,
    });
  });

  it("maps bigint gt/lt/max/multipleOf bounds", () => {
    assert.deepEqual(oas31(m.bigint().gt(5n).lt(10n).multipleOf(2n)).schema, {
      type: "integer",
      format: "int64",
      exclusiveMinimum: 5,
      exclusiveMaximum: 10,
      multipleOf: 2,
    });
    assert.deepEqual(oas31(m.bigint().max(10n)).schema, {
      type: "integer",
      format: "int64",
      maximum: 10,
    });
    for (const schema of [
      m.bigint().gt(2n ** 100n),
      m.bigint().lt(2n ** 100n),
      m.bigint().max(2n ** 100n),
      m.bigint().multipleOf(2n ** 100n),
    ]) {
      const result = oas31(schema);
      assert.deepEqual(result.schema, { type: "integer", format: "int64" });
      assert.deepEqual(
        result.warnings.map((warning) => warning.code),
        ["bigint-bound-omitted"],
      );
    }
  });

  it("maps bigint literals", () => {
    assert.deepEqual(oas31(m.literal(10n)).schema, { const: 10 });
    assert.deepEqual(oas30(m.literal(10n)).schema, { type: "integer", enum: [10] });
    const unsafe = oas31(m.literal(2n ** 100n));
    assert.deepEqual(unsafe.schema, { type: "integer", format: "int64" });
    assert.deepEqual(codesOf(unsafe), ["bigint-bound-omitted"]);
  });

  it("maps standalone undefined", () => {
    assert.deepEqual(oas31(m.undefined()).schema, {});
    assert.deepEqual(codesOf(oas31(m.undefined())), ["undefined-literal"]);
    assert.deepEqual(oas30(m.undefined()).schema, {});
  });
});

describe("oas edges: lazy and defaults", () => {
  it("computes required through lazy fields", () => {
    const result = oas31(m.object({ a: m.lazy(() => m.string()) }));
    assert.deepEqual(result.schema, {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("throws on directly self-looping lazy fields", () => {
    const self: Schema<string, string> = m.lazy<string>(() => self);
    assert.throws(() => oas31(m.object({ a: self })), /document31/);
  });

  it("omits non-finite defaults with a warning", () => {
    const result = oas31(m.number().default(Number.POSITIVE_INFINITY));
    assert.deepEqual(result.schema, { type: "number" });
    assert.deepEqual(codesOf(result), ["nonserializable-default"]);
  });

  it("omits circular defaults with a warning", () => {
    const circular: Record<string, unknown> = {};
    circular["me"] = circular;
    const result = oas31(m.string().default(circular as unknown as string));
    assert.deepEqual(result.schema, { type: "string" });
    assert.deepEqual(codesOf(result), ["nonserializable-default"]);
  });

  it("omits unsafe bigint defaults with a warning", () => {
    const result = oas31(m.bigint().default(2n ** 100n));
    assert.deepEqual(result.schema, { type: "integer", format: "int64" });
    assert.deepEqual(codesOf(result), ["nonserializable-default"]);
  });
});

describe("oas edges: documents and hostile keys", () => {
  it("wraps named nullable refs for 3.0", () => {
    const shared = m.string();
    const result31 = document31({ title: "A", version: "1" }, { S: shared, B: shared.nullable() });
    assert.deepEqual(result31.document.components.schemas["B"], {
      anyOf: [{ $ref: "#/components/schemas/S" }, { type: "null" }],
    });
    const result30 = document30({ title: "A", version: "1" }, { S: shared, B: shared.nullable() });
    assert.deepEqual(result30.document.components.schemas["B"], {
      allOf: [{ $ref: "#/components/schemas/S" }],
      nullable: true,
    });
  });

  it("emits hostile property keys as own properties", () => {
    const result = oas31(m.object({ ["__proto__"]: m.string(), a: m.string() }));
    assert.ok(Object.hasOwn(result.schema.properties ?? {}, "__proto__"));
    assert.deepEqual((result.schema.properties as Record<string, unknown>)["__proto__"], {
      type: "string",
    });
  });

  it("emits hostile component names as own properties", () => {
    const schemas: Record<string, Schema<unknown, unknown>> = {};
    Object.defineProperty(schemas, "__proto__", {
      value: m.string(),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const result = document31({ title: "A", version: "1" }, schemas);
    assert.ok(Object.hasOwn(result.document.components.schemas, "__proto__"));
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("emits hostile discriminator mappings as own properties", () => {
    const variant = m.object({ t: m.literal("__proto__") });
    const result = document31(
      { title: "A", version: "1" },
      {
        V: variant,
        R: m.discriminatedUnion("t", { ["__proto__"]: variant }),
      },
    );
    const mapping = (
      result.document.components.schemas["R"] as {
        discriminator: { mapping: Record<string, string> };
      }
    ).discriminator.mapping;
    assert.ok(Object.hasOwn(mapping, "__proto__"));
    assert.equal(mapping["__proto__"], "#/components/schemas/V");
  });
});
