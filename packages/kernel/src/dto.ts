/**
 * DTO Strategy — schema-backed contracts.
 * Per §8: DTOs should be schema-backed, not independent representations.
 * Canonical flow: Schema -> DTO contract -> Validation -> Inference -> OpenAPI/GraphQL
 */

import type { Schema } from "@minostack/schema";

export type DtoKind = "request" | "response" | "param" | "query" | "body";

export interface DtoMetadata {
  readonly name: string;
  readonly kind: DtoKind;
  readonly schema: Schema<unknown, unknown>;
  readonly description?: string;
}

// Registry for DTOs (for OpenAPI/GraphQL generation, introspection)
const DTO_REGISTRY = new Map<string, DtoMetadata>();

export function createDto<T extends Schema<unknown, unknown>>(
  name: string,
  schema: T,
  opts: { kind?: DtoKind; description?: string } = {},
): T {
  if (DTO_REGISTRY.has(name)) {
    throw new Error(
      `DTO "${name}" already registered. DTO names must be unique. Existing: ${DTO_REGISTRY.get(name)?.kind}, new: ${opts.kind ?? "request"}`,
    );
  }
  const meta: DtoMetadata = {
    name,
    kind: opts.kind ?? "request",
    schema: schema as unknown as Schema<unknown, unknown>,
    description:
      opts.description ??
      (schema as unknown as { metadata?: { description?: string } }).metadata?.description,
  };
  DTO_REGISTRY.set(name, meta);
  // Attach metadata to schema for downstream translators
  // Use facet to avoid polluting core schema model per §7
  const withFacet = (
    schema as unknown as { facet: (ns: string, payload: unknown) => unknown }
  ).facet?.("dto", meta);
  return (withFacet ?? schema) as T;
}

export function getDto(name: string): DtoMetadata | undefined {
  return DTO_REGISTRY.get(name);
}

export function listDtos(): readonly DtoMetadata[] {
  return [...DTO_REGISTRY.values()];
}

/**
 * Type helper — infer DTO type.
 */
export type InferDto<T extends Schema<unknown, unknown>> =
  T extends Schema<infer O, unknown> ? O : never;

/**
 * Decorator for class-based DTOs (alternative to functional).
 * Usage:
 * ```ts
 * @dtoClass(UserSchema)
 * class CreateUserDto {}
 * ```
 */
export function dtoClass<T extends Schema<unknown, unknown>>(
  schema: T,
  opts: { name?: string; kind?: DtoKind } = {},
): ClassDecorator {
  return (target) => {
    const name = opts.name ?? (target as { name: string }).name;
    createDto(name, schema, { kind: opts.kind });
    (target as unknown as { __dtoSchema?: T }).__dtoSchema = schema;
    (target as unknown as { __dtoName?: string }).__dtoName = name;
  };
}
