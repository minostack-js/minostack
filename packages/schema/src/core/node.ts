/**
 * Canonical schema graph.
 *
 * Every schema is an immutable value object backed by one of these nodes.
 * The interpreter (`core/validate.ts`) executes nodes; future consumers
 * (codecs, docs, formatters) read them. Nodes are never mutated after creation:
 * every modifier builds a new node.
 */

export interface Metadata {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly examples?: readonly unknown[];
  readonly deprecated?: boolean | string;
}

/** Namespaced extension data. Each key is owned by one extension. */
export interface FacetStore {
  readonly [namespace: string]: unknown;
}

export type LiteralValue = string | number | boolean | bigint | null | undefined;

export type StringCheck =
  | { readonly kind: "min"; readonly value: number; readonly message?: string }
  | { readonly kind: "max"; readonly value: number; readonly message?: string }
  | { readonly kind: "length"; readonly value: number; readonly message?: string }
  | { readonly kind: "email"; readonly message?: string }
  | { readonly kind: "url"; readonly message?: string }
  | { readonly kind: "uuid"; readonly message?: string }
  | { readonly kind: "datetime"; readonly message?: string }
  | { readonly kind: "regex"; readonly pattern: RegExp; readonly message?: string }
  | { readonly kind: "startsWith"; readonly value: string; readonly message?: string }
  | { readonly kind: "endsWith"; readonly value: string; readonly message?: string }
  | { readonly kind: "includes"; readonly value: string; readonly message?: string }
  | { readonly kind: "trim" }
  | { readonly kind: "toLowerCase" }
  | { readonly kind: "toUpperCase" };

export type NumberCheck =
  | { readonly kind: "min"; readonly value: number; readonly message?: string }
  | { readonly kind: "max"; readonly value: number; readonly message?: string }
  | { readonly kind: "gt"; readonly value: number; readonly message?: string }
  | { readonly kind: "gte"; readonly value: number; readonly message?: string }
  | { readonly kind: "lt"; readonly value: number; readonly message?: string }
  | { readonly kind: "lte"; readonly value: number; readonly message?: string }
  | { readonly kind: "multipleOf"; readonly value: number; readonly message?: string }
  | { readonly kind: "int"; readonly message?: string }
  | { readonly kind: "finite"; readonly message?: string }
  | { readonly kind: "safe"; readonly message?: string };

export type BigIntCheck =
  | { readonly kind: "min"; readonly value: bigint; readonly message?: string }
  | { readonly kind: "max"; readonly value: bigint; readonly message?: string }
  | { readonly kind: "gt"; readonly value: bigint; readonly message?: string }
  | { readonly kind: "gte"; readonly value: bigint; readonly message?: string }
  | { readonly kind: "lt"; readonly value: bigint; readonly message?: string }
  | { readonly kind: "lte"; readonly value: bigint; readonly message?: string }
  | { readonly kind: "multipleOf"; readonly value: bigint; readonly message?: string };

export type ArrayCheck =
  | { readonly kind: "min"; readonly value: number; readonly message?: string }
  | { readonly kind: "max"; readonly value: number; readonly message?: string }
  | { readonly kind: "length"; readonly value: number; readonly message?: string };

export interface Refinement {
  readonly predicate: (value: unknown) => boolean;
  readonly message?: string;
}

export type UnknownKeysPolicy = "strip" | "passthrough" | "strict";

export interface StringNode {
  readonly kind: "string";
  readonly checks: readonly StringCheck[];
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface NumberNode {
  readonly kind: "number";
  readonly checks: readonly NumberCheck[];
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface BooleanNode {
  readonly kind: "boolean";
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface BigIntNode {
  readonly kind: "bigint";
  readonly checks: readonly BigIntCheck[];
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface DateNode {
  readonly kind: "date";
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface LiteralNode {
  readonly kind: "literal";
  readonly value: LiteralValue;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface EnumNode {
  readonly kind: "enum";
  readonly values: readonly string[];
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface NullNode {
  readonly kind: "null";
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface UndefinedNode {
  readonly kind: "undefined";
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface AnyNode {
  readonly kind: "any";
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface UnknownNode {
  readonly kind: "unknown";
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface NeverNode {
  readonly kind: "never";
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface ObjectNode {
  readonly kind: "object";
  readonly fields: { readonly [key: string]: SchemaNode };
  readonly unknownKeys: UnknownKeysPolicy;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface ArrayNode {
  readonly kind: "array";
  readonly element: SchemaNode;
  readonly checks: readonly ArrayCheck[];
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface TupleNode {
  readonly kind: "tuple";
  readonly items: readonly SchemaNode[];
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface RecordNode {
  readonly kind: "record";
  readonly keys: SchemaNode;
  readonly values: SchemaNode;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface UnionNode {
  readonly kind: "union";
  readonly variants: readonly SchemaNode[];
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface DiscriminatedUnionNode {
  readonly kind: "discriminatedUnion";
  readonly discriminator: string;
  readonly variants: ReadonlyArray<{ readonly key: string; readonly node: ObjectNode }>;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface IntersectionNode {
  readonly kind: "intersection";
  readonly left: SchemaNode;
  readonly right: SchemaNode;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface OptionalNode {
  readonly kind: "optional";
  readonly inner: SchemaNode;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface NullableNode {
  readonly kind: "nullable";
  readonly inner: SchemaNode;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface DefaultNode {
  readonly kind: "default";
  readonly inner: SchemaNode;
  readonly value: unknown;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface TransformNode {
  readonly kind: "transform";
  readonly inner: SchemaNode;
  readonly transform: (value: unknown) => unknown;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface RefineNode {
  readonly kind: "refine";
  readonly inner: SchemaNode;
  readonly refinements: readonly Refinement[];
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export interface LazyNode {
  readonly kind: "lazy";
  readonly resolve: () => SchemaNode;
  readonly metadata: Metadata;
  readonly facets: FacetStore;
}

export type SchemaNode =
  | StringNode
  | NumberNode
  | BooleanNode
  | BigIntNode
  | DateNode
  | LiteralNode
  | EnumNode
  | NullNode
  | UndefinedNode
  | AnyNode
  | UnknownNode
  | NeverNode
  | ObjectNode
  | ArrayNode
  | TupleNode
  | RecordNode
  | UnionNode
  | DiscriminatedUnionNode
  | IntersectionNode
  | OptionalNode
  | NullableNode
  | DefaultNode
  | TransformNode
  | RefineNode
  | LazyNode;

export type SchemaKind = SchemaNode["kind"];

/** Fresh, unshared metadata/facets for a new node. */
export function baseNode(): { metadata: Metadata; facets: FacetStore } {
  return { metadata: {}, facets: {} };
}
