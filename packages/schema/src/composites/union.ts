import { Schema } from "../core/schema.js";
import type { InputOf, OutputOf } from "../core/schema.js";
import type { DiscriminatedUnionNode, ObjectNode, SchemaNode, UnionNode } from "../core/node.js";
import { baseNode } from "../core/node.js";
import { hasOwn } from "../core/utils.js";

export class UnionSchema<Vs extends readonly Schema<unknown, unknown>[]> extends Schema<
  OutputOf<Vs[number]>,
  InputOf<Vs[number]>
> {
  constructor(
    override readonly node: UnionNode,
    readonly variants: Vs,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new UnionSchema(node as UnionNode, this.variants) as this;
  }
}

export function union<const Vs extends readonly Schema<unknown, unknown>[]>(
  variants: Vs,
): UnionSchema<Vs> {
  if (variants.length < 2) {
    throw new Error("m.union() requires at least two variants.");
  }
  return new UnionSchema(
    { kind: "union", variants: variants.map((variant) => variant.node), ...baseNode() },
    variants,
  );
}

export class DiscriminatedUnionSchema<TOutput, TInput = TOutput> extends Schema<TOutput, TInput> {
  constructor(override readonly node: DiscriminatedUnionNode) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new DiscriminatedUnionSchema(node as DiscriminatedUnionNode) as this;
  }
}

function variantEntry(
  discriminator: string,
  label: string | null,
  schema: Schema<unknown, unknown>,
): { readonly key: string; readonly node: ObjectNode } {
  const node = schema.node;
  if (node.kind !== "object") {
    throw new Error("m.discriminatedUnion() variants must be object schemas.");
  }
  if (!hasOwn(node.fields, discriminator)) {
    throw new Error(
      `m.discriminatedUnion(): variant is missing discriminator field ${JSON.stringify(discriminator)}.`,
    );
  }
  const field = node.fields[discriminator];
  if (field === undefined || field.kind !== "literal" || typeof field.value !== "string") {
    throw new Error(
      `m.discriminatedUnion(): discriminator field ${JSON.stringify(discriminator)} must be a string literal.`,
    );
  }
  if (label !== null && field.value !== label) {
    throw new Error(
      `m.discriminatedUnion(): key ${JSON.stringify(label)} does not match literal ${JSON.stringify(field.value)}.`,
    );
  }
  return { key: field.value, node };
}

export function discriminatedUnion<
  D extends string,
  M extends Record<string, Schema<unknown, unknown>>,
>(
  discriminator: D,
  variants: M,
): DiscriminatedUnionSchema<OutputOf<M[keyof M]>, InputOf<M[keyof M]>>;
export function discriminatedUnion<
  D extends string,
  const Vs extends readonly Schema<unknown, unknown>[],
>(
  discriminator: D,
  variants: Vs,
): DiscriminatedUnionSchema<OutputOf<Vs[number]>, InputOf<Vs[number]>>;
export function discriminatedUnion(
  discriminator: string,
  variants: Record<string, Schema<unknown, unknown>> | readonly Schema<unknown, unknown>[],
): DiscriminatedUnionSchema<unknown, unknown> {
  const entries = Array.isArray(variants)
    ? variants.map((schema) => variantEntry(discriminator, null, schema))
    : Object.entries(variants).map(([label, schema]) => variantEntry(discriminator, label, schema));
  return new DiscriminatedUnionSchema({
    kind: "discriminatedUnion",
    discriminator,
    variants: entries,
    ...baseNode(),
  });
}
