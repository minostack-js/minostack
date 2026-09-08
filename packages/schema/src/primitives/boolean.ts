import { Schema } from "../core/schema.js";
import type { BooleanNode, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

export class BooleanSchema extends Schema<boolean, boolean> {
  constructor(override readonly node: BooleanNode) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new BooleanSchema(node as BooleanNode) as this;
  }
}

export function boolean(): BooleanSchema {
  return new BooleanSchema({ kind: "boolean", ...baseNode() });
}
