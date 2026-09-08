import { LazySchema, Schema } from "../core/schema.js";
import { baseNode } from "../core/node.js";

/**
 * Graph references for recursive schemas. The getter must not run at
 * construction time; it resolves on each validation.
 */
export function lazy<TOutput, TInput = TOutput>(
  getter: () => Schema<TOutput, TInput>,
): LazySchema<TOutput, TInput> {
  return new LazySchema({ kind: "lazy", resolve: () => getter().node, ...baseNode() }, getter);
}
