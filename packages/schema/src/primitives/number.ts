import { Schema } from "../core/schema.js";
import type { NumberNode, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

export class NumberSchema extends Schema<number, number> {
  constructor(override readonly node: NumberNode) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new NumberSchema(node as NumberNode) as this;
  }

  private check(check: NumberNode["checks"][number]): NumberSchema {
    return new NumberSchema({ ...this.node, checks: [...this.node.checks, check] });
  }

  min(value: number): NumberSchema {
    return this.check({ kind: "min", value });
  }

  max(value: number): NumberSchema {
    return this.check({ kind: "max", value });
  }

  gt(value: number): NumberSchema {
    return this.check({ kind: "gt", value });
  }

  gte(value: number): NumberSchema {
    return this.check({ kind: "gte", value });
  }

  lt(value: number): NumberSchema {
    return this.check({ kind: "lt", value });
  }

  lte(value: number): NumberSchema {
    return this.check({ kind: "lte", value });
  }

  multipleOf(value: number): NumberSchema {
    return this.check({ kind: "multipleOf", value });
  }

  int(): NumberSchema {
    return this.check({ kind: "int" });
  }

  finite(): NumberSchema {
    return this.check({ kind: "finite" });
  }

  safe(): NumberSchema {
    return this.check({ kind: "safe" });
  }
}

export function number(): NumberSchema {
  return new NumberSchema({ kind: "number", checks: [], ...baseNode() });
}
