/**
 * Shared types for the GraphQL SDL converter.
 *
 * Type-only module: no runtime code, excluded from line coverage
 * (guarded by `tsc` instead).
 */

import type { Schema, SchemaNode } from "@minostack/schema";

export interface GraphqlWarning {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

export interface SdlResult {
  readonly sdl: string;
  readonly warnings: GraphqlWarning[];
}

export type Declared =
  | { readonly kind: "object"; readonly typeName: string; readonly inputName: string }
  | { readonly kind: "enum"; readonly name: string }
  | { readonly kind: "union"; readonly name: string };

export interface Context {
  readonly warnings: GraphqlWarning[];
  readonly declared: Map<SchemaNode, Declared>;
  readonly names: Set<string>;
  readonly scalars: Set<"BigInt" | "DateTime" | "JSON">;
  readonly enumBlocks: string[];
  readonly unionBlocks: string[];
  readonly typeBlocks: string[];
  readonly inputBlocks: string[];
  readonly active: SchemaNode[];
  readonly federationEnabled: boolean;
  readonly federationVersion: string;
  readonly federationImports: string[];
  readonly operationTypeNames: Set<string>;
  readonly isOperationRoot: (name: string) => boolean;
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

export interface FederationOptions {
  readonly enabled?: boolean;
  readonly version?: string;
  readonly import?: readonly string[];
}

export interface FederationFacet {
  readonly key?: string;
  readonly keys?: readonly string[];
  readonly shareable?: boolean;
  readonly extends?: boolean;
  readonly external?: boolean;
  readonly provides?: string;
  readonly requires?: string;
  readonly override?: string;
  readonly tags?: readonly string[];
  readonly inaccessible?: boolean;
  readonly directives?: readonly string[];
}

// Field args via facet: schema.facet("field", { args: { id: m.string() } })
export interface FieldFacet {
  readonly args?: Record<string, Schema<unknown, unknown>>;
  readonly directives?: readonly string[];
}

// ---------------------------------------------------------------------------
// Operation roots
// ---------------------------------------------------------------------------

export type OperationFieldsInput =
  Record<string, Schema<unknown, unknown>> | Schema<unknown, unknown>;

export interface SdlOptions {
  readonly query?: OperationFieldsInput;
  readonly mutation?: OperationFieldsInput;
  readonly subscription?: OperationFieldsInput;
  readonly federation?: FederationOptions;
  /** Extra raw SDL to prepend (e.g. federation link). Advanced. */
  readonly header?: string;
}
