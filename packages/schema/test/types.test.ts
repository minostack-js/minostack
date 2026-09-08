import { assert, describe, it } from "vitest";
import { m } from "../src/index.ts";
import type { Schema } from "../src/index.ts";

type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type IsAny<T> = 0 extends 1 & T ? true : false;

type Category = { name: string; subs: Category[] };

const str = m.string();
const num = m.number();
const bool = m.boolean();
const big = m.bigint();
const dat = m.date();
const lit = m.literal("a");
const role = m.enum(["admin", "member"]);
const nul = m.null();
const und = m.undefined();
const anyS = m.any();
const unk = m.unknown();
const nev = m.never();
const user = m.object({ id: m.string(), name: m.string(), age: m.number().optional() });
const withDefault = m.object({ a: m.string().default("x") });
const arr = m.array(m.string());
const tup = m.tuple([m.string(), m.number()]);
const rec = m.record(m.number());
const recEnum = m.record(m.enum(["a", "b"]), m.number());
const recNum = m.record(m.number(), m.string());
const uni = m.union([m.string(), m.number()]);
const inter = m.intersection(m.object({ a: m.string() }), m.object({ b: m.number() }));
const opt = m.string().optional();
const nul2 = m.string().nullable();
const defStr = m.string().default("x");
const tra = m.string().transform((value) => value.length);
const cat: Schema<Category> = m.object({
  name: m.string(),
  subs: m.array(m.lazy<Category>(() => cat)),
});
const disc = m.discriminatedUnion("type", {
  success: m.object({ type: m.literal("success"), value: m.string() }),
  error: m.object({ type: m.literal("error"), message: m.string() }),
});

export const inference: [
  IsExact<m.infer<typeof str>, string>,
  IsExact<m.infer<typeof num>, number>,
  IsExact<m.infer<typeof bool>, boolean>,
  IsExact<m.infer<typeof big>, bigint>,
  IsExact<m.infer<typeof dat>, Date>,
  IsExact<m.infer<typeof lit>, "a">,
  IsExact<m.infer<typeof role>, "admin" | "member">,
  IsExact<m.infer<typeof nul>, null>,
  IsExact<m.infer<typeof und>, undefined>,
  IsAny<m.infer<typeof anyS>>,
  IsExact<m.infer<typeof unk>, unknown>,
  IsExact<m.infer<typeof nev>, never>,
  IsExact<m.infer<typeof user>, { id: string; name: string; age?: number }>,
  IsExact<m.input<typeof user>, { id: string; name: string; age?: number }>,
  IsExact<m.output<typeof user>, { id: string; name: string; age?: number }>,
  IsExact<m.infer<typeof withDefault>, { a: string }>,
  IsExact<m.input<typeof withDefault>, { a?: string | undefined }>,
  IsExact<m.infer<typeof arr>, string[]>,
  IsExact<m.infer<typeof tup>, [string, number]>,
  IsExact<m.infer<typeof rec>, Record<string, number>>,
  IsExact<m.infer<typeof recEnum>, Partial<Record<"a" | "b", number>>>,
  IsExact<m.infer<typeof recNum>, Record<number, string>>,
  IsExact<m.infer<typeof uni>, string | number>,
  IsExact<m.infer<typeof inter>, { a: string; b: number }>,
  IsExact<m.infer<typeof opt>, string | undefined>,
  IsExact<m.infer<typeof nul2>, string | null>,
  IsExact<m.infer<typeof defStr>, string>,
  IsExact<m.input<typeof defStr>, string | undefined>,
  IsExact<m.output<typeof defStr>, string>,
  IsExact<m.infer<typeof tra>, number>,
  IsExact<m.input<typeof tra>, string>,
  IsExact<m.output<typeof tra>, number>,
  IsExact<m.infer<typeof cat>, Category>,
  IsExact<
    m.infer<typeof disc>,
    { type: "success"; value: string } | { type: "error"; message: string }
  >,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];

describe("types", () => {
  it("infers static types for every kind", () => {
    assert.equal(inference.length, 34);
    assert.equal(cat.parse({ name: "a", subs: [] }).name, "a");
  });
});
