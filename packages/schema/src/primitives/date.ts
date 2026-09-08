import { Schema } from "../core/schema.js";
import type { DateNode, SchemaNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

/** Validates real `Date` instances only. Date strings stay `m.string().datetime()`. */
export class DateSchema extends Schema<Date, Date> {
  constructor(override readonly node: DateNode) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new DateSchema(node as DateNode) as this;
  }
}

export function date(): DateSchema {
  return new DateSchema({ kind: "date", ...baseNode() });
}
