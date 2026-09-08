/**
 * @minostack/schema — public entry.
 *
 * Canonical usage is the `m` facade (values and `infer`/`input`/`output`
 * helpers). Schema classes and node types are also exported for typing and
 * for extensions that read the canonical graph. Lowercase builder functions
 * stay internal: `m` is the only supported factory surface.
 */

import { LazySchema, Schema } from "./core/schema.js";
import type { InputOf, OutputOf } from "./core/schema.js";
import type { LiteralValue } from "./core/node.js";
import { string } from "./primitives/string.js";
import type { StringSchema } from "./primitives/string.js";
import { number } from "./primitives/number.js";
import type { NumberSchema } from "./primitives/number.js";
import { boolean } from "./primitives/boolean.js";
import type { BooleanSchema } from "./primitives/boolean.js";
import { bigint } from "./primitives/bigint.js";
import type { BigIntSchema } from "./primitives/bigint.js";
import { date } from "./primitives/date.js";
import type { DateSchema } from "./primitives/date.js";
import { literal } from "./primitives/literal.js";
import type { LiteralSchema } from "./primitives/literal.js";
import { enumSchema } from "./primitives/enum.js";
import type { EnumSchema } from "./primitives/enum.js";
import {
  AnySchema,
  NeverSchema,
  NullSchema,
  UndefinedSchema,
  UnknownSchema,
} from "./primitives/nullish.js";
import { object } from "./composites/object.js";
import type { Fields, ObjectSchema } from "./composites/object.js";
import { array } from "./composites/array.js";
import type { ArraySchema } from "./composites/array.js";
import { tuple } from "./composites/tuple.js";
import type { TupleSchema } from "./composites/tuple.js";
import { record } from "./composites/record.js";
import type { RecordSchema } from "./composites/record.js";
import { discriminatedUnion, union } from "./composites/union.js";
import type { DiscriminatedUnionSchema, UnionSchema } from "./composites/union.js";
import { intersection } from "./composites/intersection.js";
import type { IntersectionSchema } from "./composites/intersection.js";
import { lazy } from "./modifiers/lazy.js";

export class m {
  private constructor() {}

  static string(): StringSchema {
    return string();
  }

  static number(): NumberSchema {
    return number();
  }

  static boolean(): BooleanSchema {
    return boolean();
  }

  static bigint(): BigIntSchema {
    return bigint();
  }

  static date(): DateSchema {
    return date();
  }

  static literal<const T extends LiteralValue>(value: T): LiteralSchema<T> {
    return literal(value);
  }

  static enum<const T extends string>(values: readonly T[]): EnumSchema<T> {
    return enumSchema(values);
  }

  static null(): NullSchema {
    return new NullSchema();
  }

  static undefined(): UndefinedSchema {
    return new UndefinedSchema();
  }

  static any(): AnySchema {
    return new AnySchema();
  }

  static unknown(): UnknownSchema {
    return new UnknownSchema();
  }

  static never(): NeverSchema {
    return new NeverSchema();
  }

  static object<const F extends Fields>(fields: F): ObjectSchema<F> {
    return object(fields);
  }

  static array<E extends Schema<unknown, unknown>>(element: E): ArraySchema<E> {
    return array(element);
  }

  static tuple<const T extends readonly Schema<unknown, unknown>[]>(items: T): TupleSchema<T> {
    return tuple(items);
  }

  static record<V extends Schema<unknown, unknown>>(values: V): RecordSchema<StringSchema, V>;
  static record<K extends Schema<unknown, unknown>, V extends Schema<unknown, unknown>>(
    keys: K,
    values: V,
  ): RecordSchema<K, V>;
  static record(
    keysOrValues: Schema<unknown, unknown>,
    values?: Schema<unknown, unknown>,
  ): RecordSchema<Schema<unknown, unknown>, Schema<unknown, unknown>> {
    return values === undefined ? record(keysOrValues) : record(keysOrValues, values);
  }

  static union<const Vs extends readonly Schema<unknown, unknown>[]>(
    variants: Vs,
  ): UnionSchema<Vs> {
    return union(variants);
  }

  static discriminatedUnion<D extends string, M extends Record<string, Schema<unknown, unknown>>>(
    discriminator: D,
    variants: M,
  ): DiscriminatedUnionSchema<OutputOf<M[keyof M]>, InputOf<M[keyof M]>>;
  static discriminatedUnion<D extends string, const Vs extends readonly Schema<unknown, unknown>[]>(
    discriminator: D,
    variants: Vs,
  ): DiscriminatedUnionSchema<OutputOf<Vs[number]>, InputOf<Vs[number]>>;
  static discriminatedUnion(
    discriminator: string,
    variants: Record<string, Schema<unknown, unknown>> | readonly Schema<unknown, unknown>[],
  ): DiscriminatedUnionSchema<unknown, unknown> {
    if (Array.isArray(variants)) {
      return discriminatedUnion(discriminator, variants as readonly Schema<unknown, unknown>[]);
    }
    return discriminatedUnion(discriminator, variants as Record<string, Schema<unknown, unknown>>);
  }

  static intersection<A extends Schema<unknown, unknown>, B extends Schema<unknown, unknown>>(
    left: A,
    right: B,
  ): IntersectionSchema<A, B> {
    return intersection(left, right);
  }

  static lazy<TOutput, TInput = TOutput>(
    getter: () => Schema<TOutput, TInput>,
  ): LazySchema<TOutput, TInput> {
    return lazy(getter);
  }
}

// Namespace merging with the `m` class is what makes `m.infer`/`m.input`/`m.output`
// work as documented types alongside the `m.string()` value builders.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace m {
  export type infer<S extends Schema<unknown, unknown>> =
    S extends Schema<infer O, unknown> ? O : never;
  export type input<S extends Schema<unknown, unknown>> =
    S extends Schema<unknown, infer I> ? I : never;
  export type output<S extends Schema<unknown, unknown>> =
    S extends Schema<infer O, unknown> ? O : never;
}

export { ValidationError } from "./core/errors.js";
export type { IssueCode, ValidationIssue } from "./core/errors.js";

export {
  DefaultSchema,
  LazySchema,
  NullableSchema,
  OptionalSchema,
  Schema,
  TransformSchema,
} from "./core/schema.js";
export type {
  InputOf,
  OutputOf,
  SafeParseFailure,
  SafeParseResult,
  SafeParseSuccess,
  StandardIssue,
  StandardProps,
  StandardResult,
} from "./core/schema.js";

export type {
  AnyNode,
  ArrayCheck,
  ArrayNode,
  BigIntCheck,
  BigIntNode,
  BooleanNode,
  DateNode,
  DefaultNode,
  DiscriminatedUnionNode,
  EnumNode,
  FacetStore,
  IntersectionNode,
  LazyNode,
  LiteralNode,
  LiteralValue,
  Metadata,
  NullableNode,
  NullNode,
  NumberCheck,
  NumberNode,
  NeverNode,
  ObjectNode,
  OptionalNode,
  RecordNode,
  RefineNode,
  Refinement,
  SchemaKind,
  SchemaNode,
  StringCheck,
  StringNode,
  TransformNode,
  TupleNode,
  UndefinedNode,
  UnionNode,
  UnknownKeysPolicy,
  UnknownNode,
} from "./core/node.js";

export { StringSchema } from "./primitives/string.js";
export { NumberSchema } from "./primitives/number.js";
export { BooleanSchema } from "./primitives/boolean.js";
export { BigIntSchema } from "./primitives/bigint.js";
export { DateSchema } from "./primitives/date.js";
export { LiteralSchema } from "./primitives/literal.js";
export { EnumSchema } from "./primitives/enum.js";
export {
  AnySchema,
  NeverSchema,
  NullSchema,
  UndefinedSchema,
  UnknownSchema,
} from "./primitives/nullish.js";
export { ObjectSchema } from "./composites/object.js";
export type { Fields, ObjectInput, ObjectOutput } from "./composites/object.js";
export { ArraySchema } from "./composites/array.js";
export { TupleSchema } from "./composites/tuple.js";
export type { TupleInput, TupleOutput } from "./composites/tuple.js";
export { RecordSchema } from "./composites/record.js";
export { DiscriminatedUnionSchema, UnionSchema } from "./composites/union.js";
export { IntersectionSchema } from "./composites/intersection.js";
