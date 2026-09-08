import { DefaultSchema, OptionalSchema, Schema } from "../core/schema.js";
import type { InputOf, OutputOf } from "../core/schema.js";
import type { ObjectNode, SchemaNode, UnknownKeysPolicy } from "../core/node.js";

export type Fields = { readonly [key: string]: Schema<unknown, unknown> };

export type ObjectOutput<F extends Fields> = {
  [K in keyof F as undefined extends OutputOf<F[K]> ? never : K]: OutputOf<F[K]>;
} & {
  [K in keyof F as undefined extends OutputOf<F[K]> ? K : never]?: OutputOf<F[K]>;
};

export type ObjectInput<F extends Fields> = {
  [K in keyof F as undefined extends InputOf<F[K]> ? never : K]: InputOf<F[K]>;
} & {
  [K in keyof F as undefined extends InputOf<F[K]> ? K : never]?: InputOf<F[K]>;
};

type RequiredField<S> =
  S extends OptionalSchema<infer I>
    ? I
    : S extends DefaultSchema<unknown, unknown>
      ? S extends { readonly inner: infer I }
        ? I
        : S
      : S;

/** Assignment safe for hostile keys such as `__proto__`. */
function setField<T>(target: Record<string, T>, key: string, value: T): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

function collectNodes(fields: Fields): Record<string, SchemaNode> {
  const nodes: Record<string, SchemaNode> = {};
  for (const key of Object.keys(fields)) {
    const field = fields[key];
    if (field !== undefined) {
      setField(nodes, key, field.node);
    }
  }
  return nodes;
}

export class ObjectSchema<F extends Fields> extends Schema<ObjectOutput<F>, ObjectInput<F>> {
  constructor(
    override readonly node: ObjectNode,
    readonly fields: F,
  ) {
    super();
  }

  protected withNode(node: SchemaNode): this {
    return new ObjectSchema(node as ObjectNode, this.fields) as this;
  }

  private repolicy(unknownKeys: UnknownKeysPolicy): ObjectSchema<F> {
    return new ObjectSchema({ ...this.node, unknownKeys }, this.fields);
  }

  strip(): ObjectSchema<F> {
    return this.repolicy("strip");
  }

  passthrough(): ObjectSchema<F> {
    return this.repolicy("passthrough");
  }

  strict(): ObjectSchema<F> {
    return this.repolicy("strict");
  }

  pick<K extends keyof F & string>(mask: { readonly [P in K]?: true }): ObjectSchema<Pick<F, K>> {
    const selected: Record<string, Schema<unknown, unknown>> = {};
    for (const key of Object.keys(this.fields)) {
      if ((mask as Record<string, boolean | undefined>)[key] === true) {
        const field = this.fields[key];
        if (field !== undefined) {
          setField(selected, key, field);
        }
      }
    }
    return this.subset(selected as Pick<F, K>);
  }

  omit<K extends keyof F & string>(mask: { readonly [P in K]?: true }): ObjectSchema<Omit<F, K>> {
    const selected: Record<string, Schema<unknown, unknown>> = {};
    for (const key of Object.keys(this.fields)) {
      if ((mask as Record<string, boolean | undefined>)[key] !== true) {
        const field = this.fields[key];
        if (field !== undefined) {
          setField(selected, key, field);
        }
      }
    }
    return this.subset(selected as Omit<F, K>);
  }

  partial(): ObjectSchema<{ [K in keyof F]: OptionalSchema<F[K]> }> {
    const mapped = {} as { [K in keyof F]: OptionalSchema<F[K]> };
    for (const key of Object.keys(this.fields)) {
      const field = this.fields[key];
      if (field !== undefined) {
        setField(mapped as Record<string, Schema<unknown, unknown>>, key, field.optional());
      }
    }
    return this.subset(mapped);
  }

  required(): ObjectSchema<{ [K in keyof F]: RequiredField<F[K]> }> {
    const mapped = {} as { [K in keyof F]: RequiredField<F[K]> };
    for (const key of Object.keys(this.fields)) {
      const field = this.fields[key];
      if (field === undefined) {
        continue;
      }
      let unwrapped: Schema<unknown, unknown> = field;
      if (field instanceof OptionalSchema) {
        unwrapped = field.unwrap();
      } else if (field instanceof DefaultSchema) {
        unwrapped = field.unwrap();
      }
      setField(mapped as Record<string, Schema<unknown, unknown>>, key, unwrapped);
    }
    return this.subset(mapped);
  }

  extend<E extends Fields>(shape: E): ObjectSchema<Omit<F, keyof E> & E> {
    const fields = { ...this.fields, ...shape } as Omit<F, keyof E> & E;
    return new ObjectSchema(
      {
        kind: "object",
        fields: collectNodes(fields),
        unknownKeys: this.node.unknownKeys,
        metadata: this.node.metadata,
        facets: this.node.facets,
      },
      fields,
    );
  }

  merge<E extends Fields>(other: ObjectSchema<E>): ObjectSchema<Omit<F, keyof E> & E> {
    const fields = { ...this.fields, ...other.fields } as Omit<F, keyof E> & E;
    return new ObjectSchema(
      {
        kind: "object",
        fields: collectNodes(fields),
        unknownKeys: this.node.unknownKeys,
        metadata: { ...this.node.metadata, ...other.node.metadata },
        facets: { ...this.node.facets, ...other.node.facets },
      },
      fields,
    );
  }

  private subset<N extends Fields>(fields: N): ObjectSchema<N> {
    return new ObjectSchema(
      {
        kind: "object",
        fields: collectNodes(fields),
        unknownKeys: this.node.unknownKeys,
        metadata: this.node.metadata,
        facets: this.node.facets,
      },
      fields,
    );
  }
}

/** Default unknown-key policy is `strip`. Documented, tested, explicit. */
export function object<const F extends Fields>(fields: F): ObjectSchema<F> {
  for (const key of Object.keys(fields)) {
    if (!(fields[key] instanceof Schema)) {
      throw new Error(`m.object(): field ${JSON.stringify(key)} is not a schema.`);
    }
  }
  return new ObjectSchema(
    {
      kind: "object",
      fields: collectNodes(fields),
      unknownKeys: "strip",
      metadata: {},
      facets: {},
    },
    fields,
  );
}
