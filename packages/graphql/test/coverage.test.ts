import { assert, describe, it } from "vitest";
import { m } from "@minostack/schema";
import type { LazySchema } from "@minostack/schema";
import { sdl } from "../src/index.js";
import type { GraphqlWarning } from "../src/index.js";

function codesOf(result: { warnings: GraphqlWarning[] }): string[] {
  return result.warnings.map((warning) => warning.code);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("sdl coverage: naming", () => {
  it("dedupes colliding derived names", () => {
    const result = sdl({
      A: m.object({ x: m.object({ v: m.string() }).meta({ id: "Same" }) }),
      B: m.object({ y: m.object({ v: m.string() }).meta({ id: "Same" }) }),
    });
    assert.ok(result.sdl.includes("type Same {"));
    assert.ok(result.sdl.includes("type Same2 {"));
    assert.ok(result.warnings.some((warning) => warning.code === "name-sanitized"));
  });

  it("names empty-derived fields and empty keys", () => {
    const result = sdl({ U: m.object({ "---": m.string() }) });
    assert.ok(result.sdl.includes("___: String!"));
    assert.deepEqual(codesOf(result), ["name-sanitized"]);
    const empty = sdl({ "": m.object({ a: m.string() }) });
    assert.ok(empty.sdl.includes("type Anonymous {"));
    assert.deepEqual(codesOf(empty), ["name-sanitized"]);
  });

  it("dedupes colliding enum values", () => {
    const result = sdl({ E: m.enum(["a-b", "a_b"]) });
    assert.equal(result.sdl, "enum E {\n  a_b\n  a_b2\n}\n");
    assert.deepEqual(codesOf(result), ["name-sanitized", "name-sanitized"]);
  });

  it("shares enum declarations by node identity", () => {
    const shared = m.enum(["x"]);
    const result = sdl({ U: m.object({ a: shared, b: shared }) });
    assert.equal(count(result.sdl, "enum UA "), 1);
    assert.ok(result.sdl.includes("a: UA!"));
    assert.ok(result.sdl.includes("b: UA!"));
  });
});

describe("sdl coverage: defaults", () => {
  it("emits literal, string, boolean, null, and bigint defaults", () => {
    const result = sdl({
      U: m.object({
        k: m.literal("a").default("a"),
        s: m.string().default("hi"),
        b: m.boolean().default(true),
        n: m.string().nullable().default(null),
        big: m.bigint().default(5n),
      }),
    });
    assert.ok(result.sdl.includes("k: UK = a"));
    assert.ok(result.sdl.includes('s: String = "hi"'));
    assert.ok(result.sdl.includes("b: Boolean = true"));
    assert.ok(result.sdl.includes("n: String = null"));
    assert.ok(result.sdl.includes("big: BigInt = 5"));
    assert.deepEqual(result.warnings, []);
  });

  it("emits date, object, and null-prototype defaults", () => {
    const result = sdl({
      U: m.object({
        d: m.date().default(new Date("2024-01-02T00:00:00Z")),
        cfg: m.object({ a: m.number() }).default({ a: 1 }),
        bare: m.object({ a: m.number() }).default(
          Object.assign(Object.create(null), { a: 2 }) as unknown as {
            a: number;
          },
        ),
      }),
    });
    assert.ok(result.sdl.includes('d: DateTime = "2024-01-02T00:00:00.000Z"'));
    assert.ok(result.sdl.includes("cfg: UCfgInput = {a: 1}"));
    assert.ok(result.sdl.includes("bare: UBareInput = {a: 2}"));
  });

  it("emits array and nested defaults", () => {
    const arr = sdl({ U: m.object({ tags: m.array(m.string()).default([]) }) });
    assert.ok(arr.sdl.includes("tags: [String!] = []"));
    const filled = sdl({ U: m.object({ tags: m.array(m.string()).default(["a", "b"]) }) });
    assert.ok(filled.sdl.includes('tags: [String!] = ["a", "b"]'));
    const nestedBad = sdl({
      U: m.object({
        cfg: m.object({ a: m.number() }).default({ a: (() => 1) as unknown as number }),
      }),
    });
    assert.deepEqual(codesOf(nestedBad), ["nonserializable-default"]);
  });

  it("emits root lazy schemas and root discriminated unions", () => {
    const lazyRoot = sdl({ R: m.lazy(() => m.object({ a: m.string() })) });
    assert.ok(lazyRoot.sdl.includes("type R {"));
    const disc = sdl({
      R: m.discriminatedUnion("t", {
        a: m.object({ t: m.literal("a") }),
        b: m.object({ t: m.literal("b") }),
      }),
    });
    assert.ok(disc.sdl.includes("union R = RMember0 | RMember1"));
  });

  it("emits non-object intersections as JSON", () => {
    const result = sdl({
      U: m.object({
        v: m.intersection(
          m.string().transform((value) => value.length),
          m.string().transform((value) => value.toUpperCase()),
        ),
      }),
    });
    assert.ok(result.sdl.includes("v: JSON"));
    assert.deepEqual(codesOf(result), ["intersection-as-json"]);
  });

  it("omits unserializable defaults with warnings", () => {
    const badKey = sdl({
      U: m.object({
        cfg: m.object({ a: m.number() }).default({ "bad-key": 1 } as unknown as { a: number }),
      }),
    });
    assert.deepEqual(codesOf(badKey), ["nonserializable-default"]);
    const fn = sdl({ U: m.object({ n: m.number().default((() => 1) as unknown as number) }) });
    assert.ok(!fn.sdl.includes("="));
    assert.deepEqual(codesOf(fn), ["nonserializable-default"]);
  });

  it("uses boolean deprecation without reason", () => {
    const result = sdl({ U: m.object({ old: m.string().meta({ deprecated: true }) }) });
    assert.ok(result.sdl.includes("old: String! @deprecated\n"));
  });
});

describe("sdl coverage: kinds", () => {
  it("resolves lazy fields without cycles", () => {
    const result = sdl({ U: m.object({ a: m.lazy(() => m.string()) }) });
    assert.ok(result.sdl.includes("a: String!"));
    assert.deepEqual(result.warnings, []);
  });

  it("maps undefined literals and standalone nullish", () => {
    const undef = sdl({ U: m.object({ u: m.literal(undefined) }) });
    assert.ok(undef.sdl.includes("u: String\n"));
    assert.deepEqual(codesOf(undef), ["literal-fallback"]);
    const nul = sdl({ U: m.object({ n: m.null() }) });
    assert.ok(nul.sdl.includes("n: String\n"));
    const und = sdl({ U: m.object({ n: m.undefined() }) });
    assert.ok(und.sdl.includes("n: String\n"));
    const big = sdl({ U: m.object({ n: m.literal(10n) }) });
    assert.ok(big.sdl.includes("n: BigInt!"));
    assert.ok(big.sdl.includes("scalar BigInt"));
    const bln = sdl({ U: m.object({ n: m.literal(true) }) });
    assert.ok(bln.sdl.includes("n: Boolean!"));
    assert.deepEqual(codesOf(bln), ["literal-fallback"]);
  });

  it("emits nested discriminated unions", () => {
    const result = sdl({
      Q: m.object({
        r: m.discriminatedUnion("t", {
          a: m.object({ t: m.literal("a") }),
          b: m.object({ t: m.literal("b") }),
        }),
      }),
    });
    assert.ok(result.sdl.includes("union QR = QRMember0 | QRMember1"));
  });

  it("throws on directly self-looping lazy fields", () => {
    const self: LazySchema<string, string> = m.lazy<string>(() => self);
    assert.throws(() => sdl({ U: m.object({ loop: self }) }), /Unresolvable lazy cycle/);
  });

  it("throws on root lazy cycles", () => {
    const self: LazySchema<string, string> = m.lazy<string>(() => self);
    assert.throws(() => sdl({ R: self }), /Unresolvable lazy cycle/);
  });

  it("shares union declarations by node identity", () => {
    const shared = m.union([
      m.object({ a: m.string() }).meta({ id: "A" }),
      m.object({ b: m.string() }).meta({ id: "B" }),
    ]);
    const result = sdl({ U: m.object({ x: shared, y: shared }) });
    assert.equal(count(result.sdl, "union UX = A | B"), 1);
  });

  it("emits single-member unions directly", () => {
    const cat = m.object({ a: m.string() }).meta({ id: "Cat" });
    const result = sdl({ U: m.object({ x: m.union([cat, m.null()]) }) });
    assert.ok(!result.sdl.includes("union "));
    assert.ok(result.sdl.includes("x: Cat"));
  });

  it("emits memberless unions as JSON", () => {
    const result = sdl({ U: m.object({ x: m.union([m.null(), m.never()]) }) });
    assert.ok(result.sdl.includes("x: JSON"));
    assert.deepEqual(codesOf(result), [
      "scalar-union-as-json",
      "input-union-as-json",
      "required-nullable",
    ]);
  });

  it("warns once for duplicate roots", () => {
    const sharedObject = m.object({ a: m.string() });
    const dupObject = sdl({ A: sharedObject, B: sharedObject });
    assert.deepEqual(codesOf(dupObject), ["duplicate-type"]);
    const sharedEnum = m.enum(["x"]);
    assert.deepEqual(codesOf(sdl({ A: sharedEnum, B: sharedEnum })), ["duplicate-type"]);
    const sharedUnion = m.union([m.object({ a: m.string() }), m.object({ b: m.string() })]);
    assert.deepEqual(codesOf(sdl({ A: sharedUnion, B: sharedUnion })), ["duplicate-type"]);
    const sharedInter = m.intersection(m.object({ a: m.string() }), m.object({ b: m.number() }));
    assert.ok(codesOf(sdl({ A: sharedInter, B: sharedInter })).includes("duplicate-type"));
  });

  it("merges intersections with hostile fields safely", () => {
    const left = m.object({ ["__proto__"]: m.string(), a: m.string() });
    const result = sdl({ I: m.intersection(left, m.object({ b: m.number() })) });
    assert.ok(result.sdl.includes("a: String!"));
    assert.deepEqual(codesOf(result), ["intersection-merged"]);
  });

  it("merges nested intersections in both positions", () => {
    const result = sdl({
      U: m.object({
        m: m.intersection(m.object({ a: m.string() }), m.object({ b: m.number() })),
      }),
    });
    assert.ok(result.sdl.includes("a: String!"));
    assert.ok(result.sdl.includes("b: Float!"));
    assert.ok(result.sdl.includes("input UMInput"));
    assert.deepEqual(codesOf(result), ["intersection-merged"]);
  });
});
