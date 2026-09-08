import { assert, describe, it } from "vitest";
import { m } from "../src/index.ts";

function codesOf(schema: { safeParse(input: unknown): unknown }, input: unknown): unknown {
  const result = schema.safeParse(input) as
    | { success: true }
    | { success: false; error: { issues: ReadonlyArray<{ code: string; path: unknown }> } };
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => [issue.code, issue.path]);
}

describe("array", () => {
  it("validates elements with index paths", () => {
    const schema = m.array(m.string().min(2));
    assert.deepEqual(schema.parse(["ab", "cd"]), ["ab", "cd"]);
    assert.deepEqual(codesOf(schema, ["ab", "x"]), [["too_small", [1]]]);
    assert.deepEqual(codesOf(schema, "nope"), [["invalid_type", []]]);
  });

  it("enforces min/max/length", () => {
    assert.deepEqual(codesOf(m.array(m.string()).min(1), []), [["too_small", []]]);
    assert.deepEqual(codesOf(m.array(m.string()).max(1), ["a", "b"]), [["too_big", []]]);
    assert.deepEqual(codesOf(m.array(m.string()).length(2), ["a"]), [["too_small", []]]);
    assert.deepEqual(codesOf(m.array(m.string()).length(2), ["a", "b"]), []);
  });
});

describe("tuple", () => {
  it("validates fixed positions and exact length", () => {
    const schema = m.tuple([m.string(), m.number()]);
    assert.deepEqual(schema.parse(["a", 1]), ["a", 1]);
    assert.deepEqual(codesOf(schema, ["a"]), [["too_small", []]]);
    assert.deepEqual(codesOf(schema, ["a", 1, true]), [["too_big", []]]);
    assert.deepEqual(codesOf(schema, ["a", "b"]), [["invalid_type", [1]]]);
    assert.deepEqual(codesOf(schema, "nope"), [["invalid_type", []]]);
  });
});

describe("record", () => {
  it("validates string-keyed records", () => {
    const schema = m.record(m.number());
    assert.deepEqual(schema.parse({ a: 1 }), { a: 1 });
    assert.deepEqual(codesOf(schema, { a: "x" }), [["invalid_type", ["a"]]]);
    assert.deepEqual(codesOf(schema, null), [["invalid_type", []]]);
  });

  it("validates keys against a key schema", () => {
    const schema = m.record(m.string().min(2), m.number());
    assert.deepEqual(codesOf(schema, { a: 1 }), [["too_small", ["a"]]]);
  });

  it("supports enum keys as a closed set", () => {
    const schema = m.record(m.enum(["a", "b"]), m.number());
    assert.deepEqual(schema.parse({ a: 1 }), { a: 1 });
    assert.deepEqual(codesOf(schema, { c: 1 }), [["invalid_enum", ["c"]]]);
  });

  it("supports numeric keys", () => {
    const schema = m.record(m.number(), m.string());
    assert.deepEqual(schema.parse({ 1: "a" }), { 1: "a" });
    assert.deepEqual(codesOf(schema, { abc: "a" }), [["invalid_type", ["abc"]]]);
  });
});
