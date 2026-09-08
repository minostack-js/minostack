import { Schema } from "../core/schema.js";
import type {
  AnyNode,
  NeverNode,
  NullNode,
  SchemaNode,
  UndefinedNode,
  UnknownNode,
} from "../core/node.js";
import { baseNode } from "../core/node.js";

export class NullSchema extends Schema<null, null> {
  constructor(override readonly node: NullNode = { kind: "null", ...baseNode() }) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new NullSchema(node as NullNode) as this;
  }
}

export class UndefinedSchema extends Schema<undefined, undefined> {
  constructor(override readonly node: UndefinedNode = { kind: "undefined", ...baseNode() }) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new UndefinedSchema(node as UndefinedNode) as this;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the `any` schema genuinely means `any`.
export class AnySchema extends Schema<any, any> {
  constructor(override readonly node: AnyNode = { kind: "any", ...baseNode() }) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new AnySchema(node as AnyNode) as this;
  }
}

export class UnknownSchema extends Schema<unknown, unknown> {
  constructor(override readonly node: UnknownNode = { kind: "unknown", ...baseNode() }) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new UnknownSchema(node as UnknownNode) as this;
  }
}

export class NeverSchema extends Schema<never, never> {
  constructor(override readonly node: NeverNode = { kind: "never", ...baseNode() }) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new NeverSchema(node as NeverNode) as this;
  }
}
