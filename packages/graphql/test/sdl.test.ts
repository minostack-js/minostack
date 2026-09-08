import { assert, describe, it } from "vitest";
import { m } from "@minostack/schema";
import type { Schema } from "@minostack/schema";
import { sdl } from "../src/index.js";
import type { GraphqlWarning } from "../src/index.js";

function codesOf(result: { warnings: GraphqlWarning[] }): string[] {
  return result.warnings.map((warning) => warning.code);
}

describe("sdl objects", () => {
  it("emits types and inputs with nullability", () => {
    const result = sdl({ User: m.object({ id: m.string(), age: m.number().int().optional() }) });
    assert.equal(
      result.sdl,
      "type User {\n  id: String!\n  age: Int\n}\n\ninput UserInput {\n  id: String!\n  age: Int\n}\n",
    );
    assert.deepEqual(result.warnings, []);
  });

  it("emits defaults, descriptions, and deprecations", () => {
    const result = sdl({
      U: m.object({
        role: m.enum(["admin", "member"]).default("member"),
        count: m.number().default(3),
        old: m.string().describe("Old field").meta({ deprecated: "Use role." }),
      }),
    });
    assert.equal(
      result.sdl,
      'enum URole {\n  admin\n  member\n}\n\ntype U {\n  role: URole!\n  count: Float!\n  """Old field"""\n  old: String! @deprecated(reason: "Use role.")\n}\n\ninput UInput {\n  role: URole = member\n  count: Float = 3\n  """Old field"""\n  old: String! @deprecated(reason: "Use role.")\n}\n',
    );
    assert.deepEqual(result.warnings, []);
  });

  it("resolves recursion by name", () => {
    type Category = { name: string; subs: Category[] };
    const category: Schema<Category> = m.object({
      name: m.string(),
      subs: m.array(m.lazy<Category>(() => category)),
    });
    const result = sdl({ Category: category });
    assert.equal(
      result.sdl,
      "type Category {\n  name: String!\n  subs: [Category!]!\n}\n\ninput CategoryInput {\n  name: String!\n  subs: [CategoryInput!]!\n}\n",
    );
  });

  it("warns on required-but-nullable fields", () => {
    const result = sdl({ U: m.object({ nick: m.string().nullable() }) });
    assert.ok(result.sdl.includes("nick: String\n"));
    assert.deepEqual(codesOf(result), ["required-nullable"]);
  });

  it("uses metadata.id for nested names", () => {
    const result = sdl({
      U: m.object({ home: m.object({ city: m.string() }).meta({ id: "Address" }) }),
    });
    assert.ok(result.sdl.includes("home: Address!"));
    assert.ok(result.sdl.includes("type Address {"));
  });
});

describe("sdl scalars and enums", () => {
  it("declares custom scalars only when used", () => {
    const withBig = sdl({ A: m.object({ big: m.bigint(), when: m.date() }) });
    assert.ok(withBig.sdl.includes("scalar BigInt\n"));
    assert.ok(withBig.sdl.includes("scalar DateTime\n"));
    assert.ok(!withBig.sdl.includes("scalar JSON"));
    const plain = sdl({ A: m.object({ name: m.string() }) });
    assert.ok(!plain.sdl.includes("scalar "));
  });

  it("emits top-level enums and sanitizes values", () => {
    const result = sdl({ Role: m.enum(["admin", "a-b", "1x"]) });
    assert.equal(result.sdl, "enum Role {\n  admin\n  a_b\n  _1x\n}\n");
    assert.deepEqual(codesOf(result), ["name-sanitized", "name-sanitized"]);
  });

  it("maps literals", () => {
    const str = sdl({ U: m.object({ kind: m.literal("user") }) });
    assert.ok(str.sdl.includes("enum UKind {\n  user\n}"));
    assert.ok(str.sdl.includes("kind: UKind!"));
    const num = sdl({ U: m.object({ n: m.literal(42) }) });
    assert.ok(num.sdl.includes("n: Int!"));
    assert.deepEqual(codesOf(num), ["literal-fallback"]);
  });
});

describe("sdl unions and approximations", () => {
  it("emits unions of objects", () => {
    const result = sdl({
      Search: m.union([
        m.object({ title: m.string() }).meta({ id: "Article" }),
        m.object({ name: m.string() }).meta({ id: "Author" }),
      ]),
    });
    assert.equal(
      result.sdl,
      "union Search = Article | Author\n\ntype Article {\n  title: String!\n}\n\ntype Author {\n  name: String!\n}\n\ninput ArticleInput {\n  title: String!\n}\n\ninput AuthorInput {\n  name: String!\n}\n",
    );
  });

  it("degrades scalar unions and input unions to JSON", () => {
    const scalar = sdl({ S: m.union([m.string(), m.number()]) });
    assert.equal(scalar.sdl, "scalar JSON\n");
    assert.deepEqual(codesOf(scalar), ["scalar-union-as-json"]);
    const nested = sdl({
      Q: m.object({
        u: m.union([
          m.object({ a: m.string() }).meta({ id: "A" }),
          m.object({ b: m.string() }).meta({ id: "B" }),
        ]),
      }),
    });
    assert.ok(nested.sdl.includes("union QU = A | B"));
    const inInput = sdl({
      Q: m.object({
        u: m
          .union([
            m.object({ a: m.string() }).meta({ id: "A" }),
            m.object({ b: m.string() }).meta({ id: "B" }),
          ])
          .optional(),
      }),
    });
    assert.ok(
      inInput.warnings.some((warning) => warning.code === "input-union-as-json"),
      "input-position union warns",
    );
  });

  it("degrades tuples, records, intersections, and never", () => {
    const tuple = sdl({ T: m.object({ pair: m.tuple([m.string(), m.string()]) }) });
    assert.ok(tuple.sdl.includes("pair: [String!]"));
    assert.deepEqual(codesOf(tuple), ["tuple-length-lost"]);
    const hetero = sdl({ T: m.object({ pair: m.tuple([m.string(), m.number()]) }) });
    assert.ok(hetero.sdl.includes("pair: JSON"));
    assert.deepEqual(codesOf(hetero), ["tuple-as-json"]);
    const rec = sdl({ R: m.object({ meta: m.record(m.string()) }) });
    assert.ok(rec.sdl.includes("meta: JSON"));
    assert.deepEqual(codesOf(rec), ["record-as-json"]);
    const inter = sdl({
      I: m.intersection(m.object({ a: m.string() }), m.object({ b: m.number() })),
    });
    assert.ok(inter.sdl.includes("a: String!"));
    assert.ok(inter.sdl.includes("b: Float!"));
    assert.deepEqual(codesOf(inter), ["intersection-merged"]);
    const nev = sdl({ N: m.object({ n: m.never() }) });
    assert.ok(nev.sdl.includes("n: JSON"));
    assert.deepEqual(codesOf(nev), ["never-as-json"]);
  });

  it("handles transforms, refinements, and root edge cases", () => {
    const tra = sdl({ T: m.object({ n: m.string().transform((value) => value.length) }) });
    assert.ok(tra.sdl.includes("n: JSON"));
    assert.ok(tra.sdl.includes("n: String"));
    assert.deepEqual(codesOf(tra), ["transform-output-opaque"]);
    const ref = sdl({ R: m.object({ s: m.string().refine((value) => value.length > 0) }) });
    assert.deepEqual(codesOf(ref), ["refinement-dropped"]);
    const norm = sdl({ N: m.object({ s: m.string().trim() }) });
    assert.deepEqual(codesOf(norm), ["normalizer-dropped"]);
    const rootScalar = sdl({ S: m.string() });
    assert.deepEqual(codesOf(rootScalar), ["root-kind-unsupported"]);
  });
});
