import { assert, describe, it } from "vitest";
import { m } from "../src/index.ts";
import { StringSchema } from "../src/index.ts";

function codesOf(schema: { safeParse(input: unknown): unknown }, input: unknown): unknown {
  const result = schema.safeParse(input) as
    | { success: true }
    | { success: false; error: { issues: ReadonlyArray<{ code: string; path: unknown }> } };
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => [issue.code, issue.path]);
}

describe("transform", () => {
  it("maps output values with distinct input/output types", () => {
    const schema = m.string().transform((value) => value.length);
    assert.equal(schema.parse("abcd"), 4);
    assert.deepEqual(codesOf(schema, 42), [["invalid_type", []]]);
  });

  it("chains and runs only after successful validation", () => {
    let calls = 0;
    const schema = m
      .string()
      .transform((value) => {
        calls += 1;
        return value.length;
      })
      .transform((value) => value * 2);
    assert.equal(schema.parse("ab"), 4);
    assert.equal(calls, 1);
    calls = 0;
    assert.deepEqual(codesOf(schema, 42), [["invalid_type", []]]);
    assert.equal(calls, 0);
  });
});

describe("refine", () => {
  it("accepts with custom messages and collects all failures", () => {
    const schema = m
      .string()
      .refine((value) => value !== "forbidden", { message: "No forbidden values" })
      .refine((value) => value.length > 1);
    assert.equal(schema.parse("ok"), "ok");
    const short = schema.safeParse("x") as {
      success: boolean;
      error?: { issues: { code: string; message: string }[] };
    };
    assert.equal(short.success, false);
    assert.deepEqual(
      short.error?.issues.map((issue) => [issue.code, issue.message]),
      [["custom", "Invalid value"]],
    );
    const forbidden = schema.safeParse("forbidden") as {
      success: boolean;
      error?: { issues: { code: string; message: string }[] };
    };
    assert.equal(forbidden.success, false);
    assert.deepEqual(
      forbidden.error?.issues.map((issue) => [issue.code, issue.message]),
      [["custom", "No forbidden values"]],
    );
    const bothBad = m
      .string()
      .refine((value) => value !== "forbidden", { message: "No forbidden values" })
      .refine((value) => value.length > 100, { message: "Too short" })
      .safeParse("forbidden") as { success: boolean; error?: { issues: { code: string }[] } };
    assert.equal(bothBad.success, false);
    assert.equal(bothBad.error?.issues.filter((issue) => issue.code === "custom").length, 2);
  });

  it("skips refinements when inner validation fails", () => {
    let calls = 0;
    const schema = m.string().refine((value) => {
      calls += 1;
      return value.length > 0;
    });
    assert.deepEqual(codesOf(schema, 42), [["invalid_type", []]]);
    assert.equal(calls, 0);
  });
});

describe("metadata and facets", () => {
  it("stores descriptions, meta, and namespaced facets immutably", () => {
    const base = m.string();
    const described = base.describe("Display name").meta({ title: "Name" });
    const faceted = described.facet("openapi", { example: "Al" });
    assert.deepEqual(base.metadata, {});
    assert.equal(described.metadata["description"], "Display name");
    assert.equal(described.metadata["title"], "Name");
    assert.deepEqual(faceted.facets, { openapi: { example: "Al" } });
    assert.deepEqual(described.facets, {});
    assert.ok(described.min(1) instanceof StringSchema);
    assert.equal(described.min(1).metadata["description"], "Display name");
  });
});

describe("standard schema", () => {
  it("exposes a ~standard bridge", () => {
    const schema = m.object({ name: m.string() });
    const bridge = schema["~standard"];
    assert.equal(bridge.version, 1);
    assert.equal(bridge.vendor, "@minostack/schema");
    assert.deepEqual(bridge.validate({ name: "Al" }), { value: { name: "Al" } });
    const failed = bridge.validate({ name: 1 }) as { issues: { message: string; path: unknown }[] };
    assert.equal(failed.issues.length, 1);
    assert.deepEqual(failed.issues[0]?.path, ["name"]);
  });
});

describe("parse errors", () => {
  it("throws ValidationError carrying issues", () => {
    const schema = m.object({ age: m.number() });
    let caught: unknown;
    try {
      schema.parse({ age: "x" });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.equal((caught as { name: string }).name, "ValidationError");
    assert.deepEqual(
      (caught as unknown as { issues: { code: string; path: unknown }[] }).issues.map((issue) => [
        issue.code,
        issue.path,
      ]),
      [["invalid_type", ["age"]]],
    );
  });
});
