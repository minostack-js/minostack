import { assert, describe, it } from "vitest";
import { m } from "../src/index.ts";
import type { Schema } from "../src/index.ts";

function codesOf(schema: { safeParse(input: unknown): unknown }, input: unknown): unknown {
  const result = schema.safeParse(input) as
    | { success: true }
    | { success: false; error: { issues: ReadonlyArray<{ code: string; path: unknown }> } };
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => [issue.code, issue.path]);
}

describe("union", () => {
  it("accepts the first matching variant", () => {
    const schema = m.union([m.string(), m.number()]);
    assert.equal(schema.parse("a"), "a");
    assert.equal(schema.parse(1), 1);
  });

  it("reports invalid_union plus variant issues", () => {
    const issues = codesOf(m.union([m.string(), m.number()]), true) as Array<[string, unknown]>;
    assert.equal(issues[0]?.[0], "invalid_union");
    assert.ok(issues.some(([code]) => code === "invalid_type"));
  });

  it("preserves nested paths", () => {
    const schema = m.object({ value: m.union([m.string(), m.number()]) });
    const issues = codesOf(schema, { value: true }) as Array<[string, unknown]>;
    assert.ok(
      issues.some(
        ([code, path]) => code === "invalid_union" && (path as string[]).join() === "value",
      ),
    );
  });

  it("requires at least two variants", () => {
    assert.throws(() => m.union([m.string()]));
  });
});

describe("discriminatedUnion", () => {
  const success = m.object({ type: m.literal("success"), value: m.string() });
  const failure = m.object({ type: m.literal("error"), message: m.string() });

  it("dispatches on the discriminator (map form)", () => {
    const schema = m.discriminatedUnion("type", { success, error: failure });
    assert.deepEqual(schema.parse({ type: "success", value: "ok" }), {
      type: "success",
      value: "ok",
    });
    assert.deepEqual(codesOf(schema, { type: "success", value: 1 }), [["invalid_type", ["value"]]]);
    assert.deepEqual(codesOf(schema, { type: "unknown" }), [["invalid_union", ["type"]]]);
    assert.deepEqual(codesOf(schema, null), [["invalid_type", []]]);
  });

  it("supports the array form", () => {
    const schema = m.discriminatedUnion("type", [success, failure]);
    assert.deepEqual(schema.parse({ type: "error", message: "bad" }), {
      type: "error",
      message: "bad",
    });
    assert.deepEqual(codesOf(schema, { type: "nope" }), [["invalid_union", ["type"]]]);
  });

  it("rejects malformed variant maps at construction", () => {
    assert.throws(() => m.discriminatedUnion("type", { ok: m.string() }));
    assert.throws(() => m.discriminatedUnion("type", { ok: m.object({ type: m.string() }) }));
    assert.throws(() =>
      m.discriminatedUnion("type", { ok: m.object({ type: m.literal("other") }) }),
    );
  });
});

describe("intersection", () => {
  it("merges compatible objects", () => {
    const schema = m.intersection(m.object({ a: m.string() }), m.object({ b: m.number() }));
    assert.deepEqual(schema.parse({ a: "x", b: 1 }), { a: "x", b: 1 });
  });

  it("fails deterministically on conflicting values", () => {
    const schema = m.intersection(
      m.object({ a: m.string().transform((value) => value.length) }),
      m.object({ a: m.string() }),
    );
    assert.deepEqual(codesOf(schema, { a: "ab" }), [["invalid_intersection", ["a"]]]);
  });

  it("accepts equal primitives, rejects unequal ones", () => {
    assert.equal(m.intersection(m.literal("a"), m.string()).parse("a"), "a");
    assert.deepEqual(codesOf(m.intersection(m.literal("a"), m.literal("b")), "a"), [
      ["invalid_literal", []],
    ]);
  });
});

describe("optional / nullable / default", () => {
  it("keeps optional and nullable distinct", () => {
    assert.equal(m.string().optional().parse(undefined), undefined);
    assert.deepEqual(codesOf(m.string().optional(), null), [["invalid_type", []]]);
    assert.equal(m.string().nullable().parse(null), null);
    assert.deepEqual(codesOf(m.string().nullable(), undefined), [["invalid_type", []]]);
  });

  it("applies defaults for undefined input", () => {
    const schema = m.string().default("guest");
    assert.equal(schema.parse(undefined), "guest");
    assert.equal(schema.parse("al"), "al");
  });
});

describe("lazy", () => {
  it("supports recursive schemas", () => {
    type Category = { name: string; subs: Category[] };
    const category: Schema<Category> = m.object({
      name: m.string(),
      subs: m.array(m.lazy<Category>(() => category)),
    });
    assert.deepEqual(category.parse({ name: "a", subs: [{ name: "b", subs: [] }] }), {
      name: "a",
      subs: [{ name: "b", subs: [] }],
    });
    assert.deepEqual(codesOf(category, { name: "a", subs: [{ name: 1, subs: [] }] }), [
      ["invalid_type", ["subs", 0, "name"]],
    ]);
  });
});
