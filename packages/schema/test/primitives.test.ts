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

describe("string", () => {
  it("parses strings and rejects non-strings without coercion", () => {
    assert.equal(m.string().parse("hi"), "hi");
    assert.deepEqual(codesOf(m.string(), 42), [["invalid_type", []]]);
    assert.deepEqual(codesOf(m.string(), null), [["invalid_type", []]]);
  });

  it("enforces min/max/length", () => {
    const schema = m.string().min(2).max(4);
    assert.equal(schema.parse("abc"), "abc");
    assert.deepEqual(codesOf(schema, "a"), [["too_small", []]]);
    assert.deepEqual(codesOf(schema, "abcde"), [["too_big", []]]);
    assert.deepEqual(codesOf(m.string().length(2), "ab"), []);
    assert.deepEqual(codesOf(m.string().length(2), "a"), [["too_small", []]]);
    assert.deepEqual(codesOf(m.string().length(2), "abc"), [["too_big", []]]);
  });

  it("counts code points for length", () => {
    assert.deepEqual(codesOf(m.string().length(1), "😀"), []);
  });

  it("validates formats", () => {
    assert.deepEqual(codesOf(m.string().email(), "a@b.co"), []);
    assert.deepEqual(codesOf(m.string().email(), "nope"), [["invalid_format", []]]);
    assert.deepEqual(codesOf(m.string().url(), "https://example.com/x"), []);
    assert.deepEqual(codesOf(m.string().url(), "not a url"), [["invalid_format", []]]);
    assert.deepEqual(codesOf(m.string().uuid(), "123e4567-e89b-12d3-a456-426614174000"), []);
    assert.deepEqual(codesOf(m.string().uuid(), "xyz"), [["invalid_format", []]]);
    assert.deepEqual(codesOf(m.string().datetime(), "2024-01-02T03:04:05Z"), []);
    assert.deepEqual(codesOf(m.string().datetime(), "yesterday"), [["invalid_format", []]]);
    assert.deepEqual(codesOf(m.string().regex(/^a+$/), "aaa"), []);
    assert.deepEqual(codesOf(m.string().regex(/^a+$/), "aab"), [["invalid_format", []]]);
    assert.deepEqual(codesOf(m.string().startsWith("ab"), "abc"), []);
    assert.deepEqual(codesOf(m.string().startsWith("ab"), "xbc"), [["invalid_format", []]]);
    assert.deepEqual(codesOf(m.string().endsWith("bc"), "abc"), []);
    assert.deepEqual(codesOf(m.string().includes("b"), "abc"), []);
  });

  it("treats stateful regex flags as stateless", () => {
    const schema = m.string().regex(/a+/g);
    assert.equal(schema.parse("aaa"), "aaa");
    assert.equal(schema.parse("aaa"), "aaa");
  });

  it("applies explicit normalizers in order", () => {
    assert.equal(m.string().trim().parse("  hi  "), "hi");
    assert.equal(m.string().toLowerCase().parse("AB"), "ab");
    assert.equal(m.string().toUpperCase().parse("ab"), "AB");
    assert.equal(m.string().trim().min(2).parse("  ab  "), "ab");
    assert.deepEqual(codesOf(m.string().trim().min(2), "  a  "), [["too_small", []]]);
  });

  it("is immutable: modifiers return new schemas", () => {
    const base = m.string();
    const minned = base.min(3);
    assert.equal(base.parse("x"), "x");
    assert.deepEqual(codesOf(minned, "x"), [["too_small", []]]);
    assert.ok(base.node !== minned.node);
  });
});

describe("number", () => {
  it("parses numbers and rejects NaN and numeric strings", () => {
    assert.equal(m.number().parse(3.5), 3.5);
    assert.deepEqual(codesOf(m.number(), Number.NaN), [["invalid_type", []]]);
    assert.deepEqual(codesOf(m.number(), "42"), [["invalid_type", []]]);
  });

  it("enforces bounds", () => {
    const schema = m.number().gte(1).lte(10);
    assert.deepEqual(codesOf(schema, 0), [["too_small", []]]);
    assert.deepEqual(codesOf(schema, 11), [["too_big", []]]);
    assert.deepEqual(codesOf(m.number().gt(1), 1), [["too_small", []]]);
    assert.deepEqual(codesOf(m.number().lt(1), 1), [["too_big", []]]);
    assert.deepEqual(codesOf(m.number().min(1).max(2), 1.5), []);
  });

  it("checks int/finite/safe/multipleOf", () => {
    assert.deepEqual(codesOf(m.number().int(), 1.5), [["invalid_format", []]]);
    assert.deepEqual(codesOf(m.number().int(), 2), []);
    assert.deepEqual(codesOf(m.number().finite(), Number.POSITIVE_INFINITY), [
      ["invalid_format", []],
    ]);
    assert.deepEqual(codesOf(m.number().safe(), Number.MAX_SAFE_INTEGER + 1), [
      ["invalid_format", []],
    ]);
    assert.deepEqual(codesOf(m.number().multipleOf(0.1), 0.3), []);
    assert.deepEqual(codesOf(m.number().multipleOf(2), 3), [["invalid_format", []]]);
  });
});

describe("boolean", () => {
  it("parses booleans only", () => {
    assert.equal(m.boolean().parse(true), true);
    assert.deepEqual(codesOf(m.boolean(), 1), [["invalid_type", []]]);
    assert.deepEqual(codesOf(m.boolean(), "true"), [["invalid_type", []]]);
  });
});

describe("bigint", () => {
  it("parses bigints and enforces bounds", () => {
    assert.equal(m.bigint().parse(10n), 10n);
    assert.deepEqual(codesOf(m.bigint(), 10), [["invalid_type", []]]);
    assert.deepEqual(codesOf(m.bigint().min(5n), 3n), [["too_small", []]]);
    assert.deepEqual(codesOf(m.bigint().max(5n), 8n), [["too_big", []]]);
    assert.deepEqual(codesOf(m.bigint().multipleOf(3n), 9n), []);
    assert.deepEqual(codesOf(m.bigint().multipleOf(3n), 10n), [["invalid_format", []]]);
  });
});

describe("date", () => {
  it("validates real Dates and returns a copy", () => {
    const input = new Date("2024-05-06T00:00:00Z");
    const output = m.date().parse(input);
    assert.equal(output.getTime(), input.getTime());
    assert.ok(output !== input);
    assert.deepEqual(codesOf(m.date(), "2024-05-06"), [["invalid_type", []]]);
    assert.deepEqual(codesOf(m.date(), new Date(Number.NaN)), [["invalid_type", []]]);
  });
});

describe("literal", () => {
  it("matches exact values with Object.is semantics", () => {
    assert.equal(m.literal("a").parse("a"), "a");
    assert.equal(m.literal(42).parse(42), 42);
    assert.equal(m.literal(true).parse(true), true);
    assert.equal(m.literal(null).parse(null), null);
    assert.equal(m.literal(undefined).parse(undefined), undefined);
    assert.deepEqual(codesOf(m.literal("a"), "b"), [["invalid_literal", []]]);
    assert.deepEqual(codesOf(m.literal(Number.NaN), Number.NaN), []);
  });

  it("rejects non-primitive constructor args", () => {
    assert.throws(() => m.literal({} as unknown as string));
  });
});

describe("enum", () => {
  it("accepts members and rejects the rest", () => {
    const role = m.enum(["admin", "member"]);
    assert.equal(role.parse("admin"), "admin");
    assert.deepEqual(codesOf(role, "root"), [["invalid_enum", []]]);
    assert.deepEqual(codesOf(role, 42), [["invalid_enum", []]]);
  });

  it("rejects bad constructor args", () => {
    assert.throws(() => m.enum([]));
    assert.throws(() => m.enum(["a", 1] as unknown as string[]));
  });
});

describe("nullish", () => {
  it("validates the edge schemas", () => {
    assert.equal(m.null().parse(null), null);
    assert.deepEqual(codesOf(m.null(), undefined), [["invalid_type", []]]);
    assert.equal(m.undefined().parse(undefined), undefined);
    assert.deepEqual(codesOf(m.undefined(), null), [["invalid_type", []]]);
    assert.equal(m.any().parse(123), 123);
    assert.equal(m.unknown().parse(null), null);
    assert.deepEqual(codesOf(m.never(), null), [["invalid_type", []]]);
  });
});
