/**
 * Executable, immutable schema value objects.
 *
 * `Schema` is the public base: it runs the interpreter (`parse`/`safeParse`),
 * carries the canonical node plus metadata/facets, and exposes the shared
 * modifiers. Wrapper kinds (optional/nullable/default/transform/lazy) live
 * here alongside the base so no ESM init cycle can form: kind modules only
 * ever import *from* core, never the reverse.
 */

import { ValidationError } from "./errors.js";
import type {
  DefaultNode,
  FacetStore,
  LazyNode,
  Metadata,
  NullableNode,
  OptionalNode,
  SchemaKind,
  SchemaNode,
  TransformNode,
} from "./node.js";
import { baseNode } from "./node.js";
import { validateNode } from "./validate.js";

export type SafeParseSuccess<TOutput> = {
  readonly success: true;
  readonly data: TOutput;
};

export type SafeParseFailure = {
  readonly success: false;
  readonly error: ValidationError;
};

export type SafeParseResult<TOutput> = SafeParseSuccess<TOutput> | SafeParseFailure;

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[] | undefined;
}

export type StandardResult<TOutput> =
  { readonly value: TOutput } | { readonly issues: readonly StandardIssue[] };

export interface StandardProps<TInput, TOutput> {
  readonly version: 1;
  readonly vendor: string;
  readonly types?: { readonly input: TInput; readonly output: TOutput } | undefined;
  readonly validate: (value: unknown) => StandardResult<TOutput>;
}

export type OutputOf<S> = S extends Schema<infer O, unknown> ? O : never;
export type InputOf<S> = S extends Schema<unknown, infer I> ? I : never;

export abstract class Schema<TOutput, TInput = TOutput> {
  abstract readonly node: SchemaNode;

  /** Phantom carrier so `TInput` stays inferable now that entry points take `unknown`. */
  readonly "~input"!: TInput;

  get kind(): SchemaKind {
    return this.node.kind;
  }

  get metadata(): Metadata {
    return this.node.metadata;
  }

  get facets(): FacetStore {
    return this.node.facets;
  }

  /** Standard Schema v1 interop: `~standard.validate` delegates to `safeParse`. */
  get "~standard"(): StandardProps<TInput, TOutput> {
    return {
      version: 1,
      vendor: "@minostack/schema",
      validate: (value: unknown): StandardResult<TOutput> => {
        const result = this.safeParse(value);
        if (result.success) {
          return { value: result.data };
        }
        return {
          issues: result.error.issues.map((issue) => ({
            message: issue.message,
            path: [...issue.path],
          })),
        };
      },
    };
  }

  parse(input: unknown): TOutput {
    const result = validateNode(this.node, input, []);
    if (!result.ok) {
      throw new ValidationError(result.issues);
    }
    return result.value as TOutput;
  }

  safeParse(input: unknown): SafeParseResult<TOutput> {
    const result = validateNode(this.node, input, []);
    if (!result.ok) {
      return { success: false, error: new ValidationError(result.issues) };
    }
    return { success: true, data: result.value as TOutput };
  }

  /**
   * Rebuild the same schema around a new node. One line per subclass;
   * explicit on purpose (no `this.constructor` magic).
   */
  protected abstract withNode(node: SchemaNode): this;

  optional(): OptionalSchema<this> {
    return new OptionalSchema({ kind: "optional", inner: this.node, ...baseNode() }, this);
  }

  nullable(): NullableSchema<this> {
    return new NullableSchema({ kind: "nullable", inner: this.node, ...baseNode() }, this);
  }

  default(value: TOutput): DefaultSchema<TOutput, TInput | undefined> {
    return new DefaultSchema(
      { kind: "default", inner: this.node, value, ...baseNode() },
      this,
      value,
    );
  }

  transform<TNewOutput>(fn: (value: TOutput) => TNewOutput): TransformSchema<TNewOutput, TInput> {
    return new TransformSchema(
      {
        kind: "transform",
        inner: this.node,
        transform: fn as (value: unknown) => unknown,
        ...baseNode(),
      },
      this,
      fn as (value: unknown) => TNewOutput,
    );
  }

  refine(predicate: (value: TOutput) => boolean, options?: { readonly message?: string }): this {
    const current = this.node;
    const inner = current.kind === "refine" ? current.inner : current;
    const previous = current.kind === "refine" ? current.refinements : [];
    return this.withNode({
      kind: "refine",
      inner,
      refinements: [
        ...previous,
        { predicate: predicate as (value: unknown) => boolean, message: options?.message },
      ],
      metadata: current.metadata,
      facets: current.facets,
    });
  }

  describe(description: string): this {
    return this.withNode({
      ...this.node,
      metadata: { ...this.node.metadata, description },
    });
  }

  meta(meta: Partial<Metadata>): this {
    return this.withNode({
      ...this.node,
      metadata: { ...this.node.metadata, ...meta },
    });
  }

  facet(namespace: string, payload: unknown): this {
    return this.withNode({
      ...this.node,
      facets: { ...this.node.facets, [namespace]: payload },
    });
  }
}

export class OptionalSchema<S extends Schema<unknown, unknown>> extends Schema<
  OutputOf<S> | undefined,
  InputOf<S> | undefined
> {
  constructor(
    override readonly node: OptionalNode,
    readonly inner: S,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new OptionalSchema(node as OptionalNode, this.inner) as this;
  }

  /** The wrapped schema. @internal */
  unwrap(): S {
    return this.inner;
  }
}

export class NullableSchema<S extends Schema<unknown, unknown>> extends Schema<
  OutputOf<S> | null,
  InputOf<S> | null
> {
  constructor(
    override readonly node: NullableNode,
    readonly inner: S,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new NullableSchema(node as NullableNode, this.inner) as this;
  }

  /** The wrapped schema. @internal */
  unwrap(): S {
    return this.inner;
  }
}

export class DefaultSchema<TOutput, TInput> extends Schema<TOutput, TInput> {
  constructor(
    override readonly node: DefaultNode,
    readonly inner: Schema<TOutput, TInput>,
    readonly defaultValue: TOutput,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new DefaultSchema(node as DefaultNode, this.inner, this.defaultValue) as this;
  }

  /** The wrapped schema. @internal */
  unwrap(): Schema<TOutput, TInput> {
    return this.inner;
  }
}

export class TransformSchema<TOutput, TInput> extends Schema<TOutput, TInput> {
  constructor(
    override readonly node: TransformNode,
    readonly inner: Schema<unknown, TInput>,
    readonly fn: (value: unknown) => TOutput,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new TransformSchema(node as TransformNode, this.inner, this.fn) as this;
  }
}

export class LazySchema<TOutput, TInput = TOutput> extends Schema<TOutput, TInput> {
  constructor(
    override readonly node: LazyNode,
    readonly getter: () => Schema<TOutput, TInput>,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new LazySchema(node as LazyNode, this.getter) as this;
  }
}
