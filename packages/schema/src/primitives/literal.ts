import { Schema } from "../core/schema.js";
import type { LiteralNode, LiteralValue, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

export class LiteralSchema<T extends LiteralValue> extends Schema<T, T> {
  constructor(override readonly node: LiteralNode) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new LiteralSchema(node as LiteralNode) as this;
  }
}

export function literal<const T extends LiteralValue>(value: T): LiteralSchema<T> {
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    throw new Error(
      "m.literal() accepts only primitive values (string, number, boolean, bigint, null, undefined).",
    );
  }
  return new LiteralSchema({ kind: "literal", value, ...baseNode() });
}
