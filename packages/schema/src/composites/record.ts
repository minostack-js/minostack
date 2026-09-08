import { Schema } from "../core/schema.js";
import type { InputOf, OutputOf } from "../core/schema.js";
import type { RecordNode, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";
import { string } from "../primitives/string.js";
import type { StringSchema } from "../primitives/string.js";
import type { EnumSchema } from "../primitives/enum.js";
import type { LiteralSchema } from "../primitives/literal.js";
import type { NumberSchema } from "../primitives/number.js";
import type { UnionSchema } from "./union.js";

type KeyOf<S> =
  S extends EnumSchema<infer L>
    ? L
    : S extends LiteralSchema<infer L>
      ? L extends PropertyKey
        ? L
        : never
      : S extends UnionSchema<infer Vs>
        ? Vs extends readonly Schema<unknown, unknown>[]
          ? KeyOf<Vs[number]>
          : never
        : S extends NumberSchema
          ? number
          : string;

export type RecordOutput<K, V> =
  string extends KeyOf<K>
    ? Record<string, OutputOf<V>>
    : number extends KeyOf<K>
      ? Record<number, OutputOf<V>>
      : Partial<Record<KeyOf<K> & PropertyKey, OutputOf<V>>>;

export type RecordInput<K, V> =
  string extends KeyOf<K>
    ? Record<string, InputOf<V>>
    : number extends KeyOf<K>
      ? Record<number, InputOf<V>>
      : Partial<Record<KeyOf<K> & PropertyKey, InputOf<V>>>;

export class RecordSchema<
  K extends Schema<unknown, unknown>,
  V extends Schema<unknown, unknown>,
> extends Schema<RecordOutput<K, V>, RecordInput<K, V>> {
  constructor(
    override readonly node: RecordNode,
    readonly keys: K,
    readonly values: V,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new RecordSchema(node as RecordNode, this.keys, this.values) as this;
  }
}

export function record<V extends Schema<unknown, unknown>>(
  values: V,
): RecordSchema<StringSchema, V>;
export function record<K extends Schema<unknown, unknown>, V extends Schema<unknown, unknown>>(
  keys: K,
  values: V,
): RecordSchema<K, V>;
export function record(
  keysOrValues: Schema<unknown, unknown>,
  values?: Schema<unknown, unknown>,
): RecordSchema<Schema<unknown, unknown>, Schema<unknown, unknown>> {
  const keys = values === undefined ? string() : keysOrValues;
  const vals = values === undefined ? keysOrValues : values;
  return new RecordSchema(
    { kind: "record", keys: keys.node, values: vals.node, ...baseNode() },
    keys,
    vals,
  );
}
