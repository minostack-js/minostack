import { Schema } from "../core/schema.js";
import type { InputOf, OutputOf } from "../core/schema.js";
import type { IntersectionNode, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

export class IntersectionSchema<
  A extends Schema<unknown, unknown>,
  B extends Schema<unknown, unknown>,
> extends Schema<OutputOf<A> & OutputOf<B>, InputOf<A> & InputOf<B>> {
  constructor(
    override readonly node: IntersectionNode,
    readonly left: A,
    readonly right: B,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new IntersectionSchema(node as IntersectionNode, this.left, this.right) as this;
  }
}

export function intersection<
  A extends Schema<unknown, unknown>,
  B extends Schema<unknown, unknown>,
>(left: A, right: B): IntersectionSchema<A, B> {
  return new IntersectionSchema(
    { kind: "intersection", left: left.node, right: right.node, ...baseNode() },
    left,
    right,
  );
}
