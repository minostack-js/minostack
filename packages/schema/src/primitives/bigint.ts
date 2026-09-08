import { Schema } from "../core/schema.js";
import type { BigIntNode, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

export class BigIntSchema extends Schema<bigint, bigint> {
  constructor(override readonly node: BigIntNode) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new BigIntSchema(node as BigIntNode) as this;
  }

  private check(check: BigIntNode["checks"][number]): BigIntSchema {
    return new BigIntSchema({ ...this.node, checks: [...this.node.checks, check] });
  }

  min(value: bigint): BigIntSchema {
    return this.check({ kind: "min", value });
  }

  max(value: bigint): BigIntSchema {
    return this.check({ kind: "max", value });
  }

  gt(value: bigint): BigIntSchema {
    return this.check({ kind: "gt", value });
  }

  gte(value: bigint): BigIntSchema {
    return this.check({ kind: "gte", value });
  }

  lt(value: bigint): BigIntSchema {
    return this.check({ kind: "lt", value });
  }

  lte(value: bigint): BigIntSchema {
    return this.check({ kind: "lte", value });
  }

  multipleOf(value: bigint): BigIntSchema {
    return this.check({ kind: "multipleOf", value });
  }
}

export function bigint(): BigIntSchema {
  return new BigIntSchema({ kind: "bigint", checks: [], ...baseNode() });
}
