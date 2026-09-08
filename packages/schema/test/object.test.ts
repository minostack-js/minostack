import { assert, describe, it } from "vitest";
import { m } from "../src/index.ts";
import type { ValidationIssue } from "../src/index.ts";

function failureOf(
  schema: { safeParse(input: unknown): unknown },
  input: unknown,
): ValidationIssue[] {
  const result = schema.safeParse(input) as
    { success: true } | { success: false; error: { issues: ValidationIssue[] } };
  assert.equal(result.success, false);
  return [...(result as { success: false; error: { issues: ValidationIssue[] } }).error.issues];
}

describe("object", () => {
  const user = m.object({
    id: m.string().uuid(),
    name: m.string().min(2),
    age: m.number().int().optional(),
  });

  it("parses valid objects", () => {
    assert.deepEqual(user.parse({ id: "123e4567-e89b-12d3-a456-426614174000", name: "Al" }), {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Al",
    });
  });

  it("strips unknown keys by default", () => {
    assert.deepEqual(
      user.parse({ id: "123e4567-e89b-12d3-a456-426614174000", name: "Al", admin: true }),
      { id: "123e4567-e89b-12d3-a456-426614174000", name: "Al" },
    );
  });

  it("supports passthrough and strict policies", () => {
    const input = { id: "123e4567-e89b-12d3-a456-426614174000", name: "Al", admin: true };
    assert.deepEqual(user.passthrough().parse(input), input);
    const issues = failureOf(user.strict(), input);
    assert.deepEqual(
      issues.map((issue) => [issue.code, issue.path]),
      [["unrecognized_keys", ["admin"]]],
    );
  });

  it("reports nested paths precisely", () => {
    const schema = m.object({ users: m.array(m.object({ email: m.string() })) });
    const issues = failureOf(schema, { users: [{ email: 123 }] });
    assert.deepEqual(
      issues.map((issue) => [issue.code, issue.path]),
      [["invalid_type", ["users", 0, "email"]]],
    );
  });

  it("rejects non-objects and reports missing keys", () => {
    const issues = failureOf(m.object({ a: m.string() }), null);
    assert.deepEqual(
      issues.map((issue) => [issue.code, issue.path]),
      [["invalid_type", []]],
    );
    const missing = failureOf(m.object({ a: m.string() }), {});
    assert.deepEqual(
      missing.map((issue) => [issue.code, issue.path]),
      [["invalid_type", ["a"]]],
    );
  });

  it("handles optional, nullable, and defaulted fields", () => {
    const schema = m.object({
      a: m.string().optional(),
      b: m.string().nullable(),
      c: m.string().default("hi"),
      d: m.array(m.string()).default([]),
    });
    assert.deepEqual(schema.parse({ b: null }), { b: null, c: "hi", d: [] });
    const first = schema.parse({ b: null });
    const second = schema.parse({ b: null });
    assert.ok((first as { d: unknown[] }).d !== (second as { d: unknown[] }).d);
  });

  it("supports pick/omit/partial/required/extend/merge", () => {
    const base = m.object({ id: m.string(), name: m.string(), age: m.number().optional() });
    assert.deepEqual(
      Object.keys(base.pick({ id: true, name: true }).parse({ id: "1", name: "n", age: 3 })),
      ["id", "name"],
    );
    assert.deepEqual(Object.keys(base.omit({ age: true }).parse({ id: "1", name: "n", age: 3 })), [
      "id",
      "name",
    ]);
    assert.deepEqual(base.partial().parse({}), {});
    assert.deepEqual(
      failureOf(base.required(), { id: "1", name: "n" }).map((issue) => issue.path),
      [["age"]],
    );
    assert.deepEqual(Object.keys(base.extend({ extra: m.boolean() }).fields), [
      "id",
      "name",
      "age",
      "extra",
    ]);
    const merged = base.merge(m.object({ name: m.number(), tag: m.string() }));
    assert.deepEqual(merged.parse({ id: "1", name: 5, tag: "t" }), { id: "1", name: 5, tag: "t" });
    assert.deepEqual(
      failureOf(merged, { id: "1", name: "x", tag: "t" }).map((issue) => [issue.code, issue.path]),
      [["invalid_type", ["name"]]],
    );
  });

  it("preserves metadata across object utilities", () => {
    const base = m.object({ a: m.string() }).describe("base object");
    assert.equal(base.pick({ a: true }).metadata["description"], "base object");
    assert.equal(base.partial().metadata["description"], "base object");
  });

  it("rejects non-schema fields at construction", () => {
    assert.throws(() => m.object({ a: 42 } as unknown as Record<string, never>));
  });
});
