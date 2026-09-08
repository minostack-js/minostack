import { assert, describe, it } from "vitest";
import { m } from "../src/index.ts";
import { ValidationError } from "../src/index.ts";
import type { ValidationIssue } from "../src/index.ts";

function codesOf(schema: { safeParse(input: unknown): unknown }, input: unknown): unknown {
  const result = schema.safeParse(input) as
    | { success: true }
    | { success: false; error: { issues: ReadonlyArray<{ code: string; path: unknown }> } };
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => [issue.code, issue.path]);
}

describe("edges: bounds and guards", () => {
  it("enforces bigint gt/gte/lt/lte", () => {
    assert.deepEqual(codesOf(m.bigint().gt(5n), 5n), [["too_small", []]]);
    assert.deepEqual(codesOf(m.bigint().gt(5n), 6n), []);
    assert.deepEqual(codesOf(m.bigint().gte(5n), 5n), []);
    assert.deepEqual(codesOf(m.bigint().lt(5n), 5n), [["too_big", []]]);
    assert.deepEqual(codesOf(m.bigint().lt(5n), 4n), []);
    assert.deepEqual(codesOf(m.bigint().lte(5n), 5n), []);
  });

  it("rejects multipleOf(0)", () => {
    assert.deepEqual(codesOf(m.number().multipleOf(0), 5), [["invalid_format", []]]);
  });

  it("constructs empty ValidationErrors", () => {
    const error = new ValidationError([]);
    assert.equal(error.message, "Validation failed");
    assert.deepEqual(error.issues, []);
  });

  it("validates undefined-accepting unions in required computation", () => {
    const schema = m.object({ a: m.union([m.string(), m.undefined()]), b: m.string() });
    assert.deepEqual(Object.keys(schema.parse({ b: "x" })), ["a", "b"]);
  });
});

describe("edges: unions and intersections", () => {
  it("labels rich variants in union failures", () => {
    const schema = m.union([
      m.literal("a"),
      m.enum(["x"]),
      m.string().optional(),
      m.string().nullable(),
      m.string().default("d"),
      m.string().transform((value) => value.length),
      m.string().refine(() => false),
      m.lazy(() => m.boolean()),
      m.discriminatedUnion("t", { a: m.object({ t: m.literal("a") }) }),
    ]);
    const result = schema.safeParse(123) as {
      success: boolean;
      error?: { issues: { code: string }[] };
    };
    assert.equal(result.success, false);
    assert.equal(result.error?.issues[0]?.code, "invalid_union");
  });

  it("rejects missing discriminators", () => {
    const schema = m.discriminatedUnion("type", { a: m.object({ type: m.literal("a") }) });
    assert.deepEqual(codesOf(schema, {}), [["invalid_union", ["type"]]]);
  });

  it("rejects variants missing the discriminator at construction", () => {
    assert.throws(() => m.discriminatedUnion("type", { a: m.object({ nope: m.string() }) }));
  });

  it("fails intersections of disagreeing non-objects", () => {
    const schema = m.intersection(
      m.string().transform((value) => value.length),
      m.string().transform((value) => value.toUpperCase()),
    );
    assert.deepEqual(codesOf(schema, "ab"), [["invalid_intersection", []]]);
  });

  it("compares dates, arrays, and nested objects by value", () => {
    const instant = new Date("2024-01-01T00:00:00Z");
    const epoch = m.date().transform(() => new Date(0));
    const epoch1 = m.date().transform(() => new Date(1));
    assert.deepEqual(
      m.intersection(m.object({ d: epoch }), m.object({ d: epoch })).parse({ d: instant }),
      {
        d: new Date(0),
      },
    );
    assert.deepEqual(
      codesOf(m.intersection(m.object({ d: epoch }), m.object({ d: epoch1 })), { d: instant }),
      [["invalid_intersection", ["d"]]],
    );
    assert.deepEqual(
      codesOf(m.intersection(m.object({ d: epoch }), m.object({ d: epoch })), { d: "nope" }),
      [
        ["invalid_type", ["d"]],
        ["invalid_type", ["d"]],
      ],
    );
    const split = m.string().transform((value) => value.split(""));
    const wrap = m.string().transform((value) => [value]);
    assert.deepEqual(
      codesOf(m.intersection(m.object({ a: split }), m.object({ a: wrap })), { a: "ab" }),
      [["invalid_intersection", ["a"]]],
    );
    assert.deepEqual(
      m.intersection(m.object({ a: split }), m.object({ a: split })).parse({ a: "ab" }),
      { a: ["a", "b"] },
    );
    const left = m.string().transform(() => ({ x: 1, y: 2 }));
    const right = m.string().transform(() => ({ x: 1 }));
    assert.deepEqual(
      codesOf(m.intersection(m.object({ a: left }), m.object({ a: right })), { a: "k" }),
      [["invalid_intersection", ["a"]]],
    );
    const other = m.string().transform(() => ({ x: 2 }));
    assert.deepEqual(
      codesOf(m.intersection(m.object({ a: left }), m.object({ a: other })), { a: "k" }),
      [["invalid_intersection", ["a"]]],
    );
    assert.deepEqual(
      m.intersection(m.object({ a: left }), m.object({ a: left })).parse({ a: "k" }),
      { a: { x: 1, y: 2 } },
    );
  });
});

describe("edges: records and defaults", () => {
  it("rejects non-numeric keys against numeric checks", () => {
    const schema = m.record(m.number().min(5), m.string());
    assert.deepEqual(schema.parse({ 7: "a" }), { 7: "a" });
    assert.deepEqual(codesOf(schema, { 3: "a" }), [["too_small", ["3"]]]);
  });

  it("fresh-copies object defaults per parse", () => {
    const schema = m.object({ cfg: m.object({ a: m.number() }).default({ a: 1 }) });
    const first = schema.parse({});
    const second = schema.parse({});
    assert.deepEqual(first, { cfg: { a: 1 } });
    assert.ok((first as { cfg: unknown }).cfg !== (second as { cfg: unknown }).cfg);
  });

  it("drops defaults on required()", () => {
    const schema = m.object({ a: m.string().default("x"), b: m.number() }).required();
    assert.deepEqual(codesOf(schema, {}), [
      ["invalid_type", ["a"]],
      ["invalid_type", ["b"]],
    ]);
    assert.deepEqual(schema.parse({ a: "y", b: 1 }), { a: "y", b: 1 });
  });

  it("exposes strip() explicitly", () => {
    const schema = m.object({ a: m.string() }).strict().strip();
    assert.deepEqual(schema.parse({ a: "x", extra: 1 }), { a: "x" });
  });
});

describe("edges: hostile keys", () => {
  it("round-trips __proto__ through passthrough without pollution", () => {
    const schema = m.object({ a: m.string() }).passthrough();
    const input = JSON.parse('{"a":"x","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const output = schema.parse(input) as Record<string, unknown>;
    assert.ok(Object.hasOwn(output, "__proto__"));
    assert.deepEqual(output["__proto__"], { polluted: true });
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    assert.ok(JSON.stringify(output).includes("__proto__"));
  });

  it("supports declared __proto__ fields", () => {
    const schema = m.object({ ["__proto__"]: m.string() });
    const output = schema.parse(JSON.parse('{"__proto__":"x"}')) as Record<string, unknown>;
    assert.ok(Object.hasOwn(output, "__proto__"));
    assert.equal(output["__proto__"], "x");
  });
});

describe("edges: message inputs", () => {
  it("labels null and array receivers", () => {
    assert.deepEqual(codesOf(m.literal("a"), null), [["invalid_literal", []]]);
    assert.deepEqual(codesOf(m.literal("a"), [1]), [["invalid_literal", []]]);
    assert.deepEqual(codesOf(m.string(), [1]), [["invalid_type", []]]);
  });

  it("reports failures through ValidationIssue paths", () => {
    const issues = ((): ValidationIssue[] => {
      const result = m.object({ a: m.string() }).safeParse({}) as
        { success: true } | { success: false; error: ValidationError };
      assert.equal(result.success, false);
      return [...(result as { success: false; error: ValidationError }).error.issues];
    })();
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, "invalid_type");
  });
});
