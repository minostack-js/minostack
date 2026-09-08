import { Schema } from "../core/schema.js";
import type { EnumNode, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

/** String-literal unions. Deliberately not TypeScript `enum`s. */
export class EnumSchema<T extends string> extends Schema<T, T> {
  constructor(override readonly node: EnumNode) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new EnumSchema(node as EnumNode) as this;
  }
}

/** Named `enumSchema` because `enum` is a reserved word. Exposed as `m.enum()`. */
export function enumSchema<const T extends string>(values: readonly T[]): EnumSchema<T> {
  if (values.length === 0) {
    throw new Error("m.enum() requires at least one value.");
  }
  for (const value of values) {
    if (typeof value !== "string") {
      throw new Error("m.enum() accepts only string literals.");
    }
  }
  return new EnumSchema({ kind: "enum", values: [...values], ...baseNode() });
}
