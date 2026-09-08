import { Schema } from "../core/schema.js";
import type { InputOf, OutputOf } from "../core/schema.js";
import type { SchemaNode, TupleNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

export type TupleOutput<T extends readonly Schema<unknown, unknown>[]> = {
  -readonly [K in keyof T]: OutputOf<T[K]>;
};

export type TupleInput<T extends readonly Schema<unknown, unknown>[]> = {
  -readonly [K in keyof T]: InputOf<T[K]>;
};

export class TupleSchema<T extends readonly Schema<unknown, unknown>[]> extends Schema<
  TupleOutput<T>,
  TupleInput<T>
> {
  constructor(
    override readonly node: TupleNode,
    readonly items: T,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new TupleSchema(node as TupleNode, this.items) as this;
  }
}

/** Fixed-length tuples. No rest elements in v0.1. */
export function tuple<const T extends readonly Schema<unknown, unknown>[]>(
  items: T,
): TupleSchema<T> {
  return new TupleSchema(
    { kind: "tuple", items: items.map((item) => item.node), ...baseNode() },
    items,
  );
}
