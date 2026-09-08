import { Schema } from "../core/schema.js";
import type { InputOf, OutputOf } from "../core/schema.js";
import type { ArrayNode, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

export class ArraySchema<E extends Schema<unknown, unknown>> extends Schema<
  OutputOf<E>[],
  InputOf<E>[]
> {
  constructor(
    override readonly node: ArrayNode,
    readonly element: E,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new ArraySchema(node as ArrayNode, this.element) as this;
  }

  private check(check: ArrayNode["checks"][number]): ArraySchema<E> {
    return new ArraySchema({ ...this.node, checks: [...this.node.checks, check] }, this.element);
  }

  min(length: number): ArraySchema<E> {
    return this.check({ kind: "min", value: length });
  }

  max(length: number): ArraySchema<E> {
    return this.check({ kind: "max", value: length });
  }

  length(length: number): ArraySchema<E> {
    return this.check({ kind: "length", value: length });
  }
}

export function array<E extends Schema<unknown, unknown>>(element: E): ArraySchema<E> {
  return new ArraySchema(
    { kind: "array", element: element.node, checks: [], ...baseNode() },
    element,
  );
}
