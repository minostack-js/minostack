import { Schema } from "../core/schema.js";
import type { SchemaNode, StringNode } from "../core/node.js";
import { baseNode } from "../core/node.js";

export class StringSchema extends Schema<string, string> {
  constructor(override readonly node: StringNode) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new StringSchema(node as StringNode) as this;
  }

  private check(check: StringNode["checks"][number]): StringSchema {
    return new StringSchema({ ...this.node, checks: [...this.node.checks, check] });
  }

  min(length: number): StringSchema {
    return this.check({ kind: "min", value: length });
  }

  max(length: number): StringSchema {
    return this.check({ kind: "max", value: length });
  }

  length(length: number): StringSchema {
    return this.check({ kind: "length", value: length });
  }

  email(): StringSchema {
    return this.check({ kind: "email" });
  }

  url(): StringSchema {
    return this.check({ kind: "url" });
  }

  uuid(): StringSchema {
    return this.check({ kind: "uuid" });
  }

  datetime(): StringSchema {
    return this.check({ kind: "datetime" });
  }

  regex(pattern: RegExp): StringSchema {
    // `g`/`y` flags make `.test` stateful; store a stateless copy.
    const clean = new RegExp(pattern.source, pattern.flags.replaceAll("g", "").replaceAll("y", ""));
    return this.check({ kind: "regex", pattern: clean });
  }

  startsWith(value: string): StringSchema {
    return this.check({ kind: "startsWith", value });
  }

  endsWith(value: string): StringSchema {
    return this.check({ kind: "endsWith", value });
  }

  includes(value: string): StringSchema {
    return this.check({ kind: "includes", value });
  }

  /** Normalizes: trims the parsed value. Explicitly requested, not silent. */
  trim(): StringSchema {
    return this.check({ kind: "trim" });
  }

  /** Normalizes: lowercases the parsed value. */
  toLowerCase(): StringSchema {
    return this.check({ kind: "toLowerCase" });
  }

  /** Normalizes: uppercases the parsed value. */
  toUpperCase(): StringSchema {
    return this.check({ kind: "toUpperCase" });
  }
}

export function string(): StringSchema {
  return new StringSchema({ kind: "string", checks: [], ...baseNode() });
}
