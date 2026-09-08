import { assert, describe, it } from "vitest";
import { m } from "../src/index.ts";
import type { Schema } from "../src/index.ts";

const cases: Array<[string, Schema<unknown, unknown>]> = [
  ["string", m.string()],
  ["number", m.number()],
  ["boolean", m.boolean()],
  ["bigint", m.bigint()],
  ["date", m.date()],
  ["literal", m.literal("a")],
  ["enum", m.enum(["a"])],
  ["null", m.null()],
  ["undefined", m.undefined()],
  ["any", m.any()],
  ["unknown", m.unknown()],
  ["never", m.never()],
  ["object", m.object({ a: m.string() })],
  ["array", m.array(m.string())],
  ["tuple", m.tuple([m.string()])],
  ["record", m.record(m.string())],
  ["union", m.union([m.string(), m.number()])],
  ["discUnion", m.discriminatedUnion("t", { a: m.object({ t: m.literal("a") }) })],
  ["intersection", m.intersection(m.object({}), m.object({}))],
  ["optional", m.string().optional()],
  ["nullable", m.string().nullable()],
  ["default", m.string().default("x")],
  ["transform", m.string().transform((value) => value)],
  ["lazy", m.lazy(() => m.string())],
];

describe("modifiers preserve kind across every schema", () => {
  it("describe/meta/facet", () => {
    for (const [name, schema] of cases) {
      const next = schema.describe(`${name} schema`).meta({ title: name }).facet("test", { n: 1 });
      assert.equal(next.kind, schema.kind);
      assert.equal(next.metadata.description, `${name} schema`);
      assert.equal(next.metadata.title, name);
      assert.deepEqual(next.facets, { test: { n: 1 } });
      assert.equal(schema.metadata.description, undefined);
      assert.deepEqual(schema.facets, {});
    }
  });

  it("refine", () => {
    for (const [name, schema] of cases) {
      const next = schema.refine(() => true);
      assert.equal(next.kind, "refine", name);
      assert.ok(schema.kind !== "refine", name);
    }
  });
});
