/**
 * Public types for `@minostack/openapi`.
 *
 * Type-only module: no runtime code, excluded from line coverage
 * (guarded by `tsc` instead).
 */

import type { Schema } from "@minostack/schema";

export type OpenApiVersion = "3.1" | "3.0";

export interface OasSchema {
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  deprecated?: boolean;
  examples?: unknown[];
  example?: unknown;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  allOf?: OasSchema[];
  anyOf?: OasSchema[];
  oneOf?: OasSchema[];
  not?: OasSchema;
  items?: OasSchema;
  prefixItems?: OasSchema[];
  properties?: Record<string, OasSchema>;
  required?: string[];
  additionalProperties?: boolean | OasSchema;
  propertyNames?: OasSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  nullable?: boolean;
  $ref?: string;
}

// ---------------------------------------------------------------------------
// Reusable OpenAPI objects (output side — already converted)
// ---------------------------------------------------------------------------

export interface ServerVariableObject {
  enum?: string[];
  default: string;
  description?: string;
}

export interface ServerObject {
  url: string;
  description?: string;
  variables?: Record<string, ServerVariableObject>;
}

export interface TagObject {
  name: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
}

export interface ExternalDocumentationObject {
  description?: string;
  url: string;
}

export type SecurityRequirementObject = Record<string, string[]>;

export interface SecuritySchemeObject {
  type: string;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flows?: unknown;
  openIdConnectUrl?: string;
  [key: string]: unknown;
}

export interface ExampleObject {
  summary?: string;
  description?: string;
  value?: unknown;
  externalValue?: string;
}

export interface EncodingObject {
  contentType?: string;
  headers?: Record<string, HeaderObject | { $ref: string }>;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
}

export interface HeaderObject {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  schema?: OasSchema;
  example?: unknown;
  examples?: Record<string, ExampleObject | { $ref: string }>;
  content?: Record<string, MediaTypeObject>;
}

export interface MediaTypeObject {
  schema?: OasSchema | { $ref: string };
  example?: unknown;
  examples?: Record<string, ExampleObject | { $ref: string }>;
  encoding?: Record<string, EncodingObject>;
}

export interface RequestBodyObject {
  description?: string;
  content: Record<string, MediaTypeObject>;
  required?: boolean;
}

export interface ResponseObject {
  description: string;
  headers?: Record<string, HeaderObject | { $ref: string }>;
  content?: Record<string, MediaTypeObject>;
  links?: Record<string, unknown>;
}

export interface ParameterObject {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  schema?: OasSchema | { $ref: string };
  example?: unknown;
  examples?: Record<string, ExampleObject | { $ref: string }>;
  content?: Record<string, MediaTypeObject>;
}

export interface OperationObject {
  tags?: string[];
  summary?: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
  operationId?: string;
  parameters?: Array<ParameterObject | { $ref: string }>;
  requestBody?: RequestBodyObject | { $ref: string };
  responses?: Record<string, ResponseObject | { $ref: string }>;
  callbacks?: Record<string, unknown>;
  deprecated?: boolean;
  security?: SecurityRequirementObject[];
  servers?: ServerObject[];
}

export interface PathItemObject {
  summary?: string;
  description?: string;
  servers?: ServerObject[];
  parameters?: Array<ParameterObject | { $ref: string }>;
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  delete?: OperationObject;
  options?: OperationObject;
  head?: OperationObject;
  patch?: OperationObject;
  trace?: OperationObject;
}

// ---------------------------------------------------------------------------
// Input side — schema fields may be `Schema` instances (converted with $ref)
// ---------------------------------------------------------------------------

export type SchemaInput = Schema<unknown, unknown> | OasSchema | { $ref: string };

export interface MediaTypeInput {
  schema?: SchemaInput;
  example?: unknown;
  examples?: Record<string, ExampleObject | { $ref: string }>;
  encoding?: Record<string, EncodingObject>;
}

export interface RequestBodyInput {
  description?: string;
  content: Record<string, MediaTypeInput>;
  required?: boolean;
}

export type RequestBodyInputOrRef = RequestBodyInput | { $ref: string };

export interface ResponseInput {
  description: string;
  headers?: Record<string, HeaderObject | { $ref: string }>;
  content?: Record<string, MediaTypeInput>;
  links?: Record<string, unknown>;
}

export type ResponseInputOrRef = ResponseInput | { $ref: string };

export interface ParameterInput {
  name: string;
  in: string;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  schema?: SchemaInput;
  example?: unknown;
  examples?: Record<string, ExampleObject | { $ref: string }>;
  content?: Record<string, MediaTypeInput>;
}

export type ParameterInputOrRef = ParameterInput | { $ref: string };

export interface OperationInput {
  tags?: string[];
  summary?: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
  operationId?: string;
  parameters?: ParameterInputOrRef[];
  requestBody?: RequestBodyInputOrRef;
  responses?: Record<string, ResponseInputOrRef>;
  callbacks?: Record<string, unknown>;
  deprecated?: boolean;
  security?: SecurityRequirementObject[];
  servers?: ServerObject[];
}

export interface PathItemInput {
  summary?: string;
  description?: string;
  servers?: ServerObject[];
  parameters?: ParameterInputOrRef[];
  get?: OperationInput;
  put?: OperationInput;
  post?: OperationInput;
  delete?: OperationInput;
  options?: OperationInput;
  head?: OperationInput;
  patch?: OperationInput;
  trace?: OperationInput;
}

export type PathsInput = Record<string, PathItemInput>;
export type WebhooksInput = Record<string, PathItemInput>;

export interface ComponentsInput {
  schemas?: Record<string, SchemaInput>;
  responses?: Record<string, ResponseInputOrRef>;
  parameters?: Record<string, ParameterInputOrRef>;
  requestBodies?: Record<string, RequestBodyInputOrRef>;
  headers?: Record<string, HeaderObject | { $ref: string }>;
  securitySchemes?: Record<string, SecuritySchemeObject>;
  examples?: Record<string, ExampleObject | { $ref: string }>;
  links?: Record<string, unknown>;
  callbacks?: Record<string, unknown>;
  pathItems?: Record<string, PathItemInput>;
}

export interface DocumentOptions {
  servers?: ServerObject[];
  paths?: PathsInput;
  webhooks?: WebhooksInput;
  components?: ComponentsInput;
  security?: SecurityRequirementObject[];
  tags?: TagObject[];
  externalDocs?: ExternalDocumentationObject;
  jsonSchemaDialect?: string;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  jsonSchemaDialect?: string;
  servers?: ServerObject[];
  paths: Record<string, PathItemObject>;
  webhooks?: Record<string, PathItemObject>;
  components: {
    schemas: Record<string, OasSchema>;
    responses?: Record<string, ResponseObject | { $ref: string }>;
    parameters?: Record<string, ParameterObject | { $ref: string }>;
    requestBodies?: Record<string, RequestBodyObject | { $ref: string }>;
    headers?: Record<string, HeaderObject | { $ref: string }>;
    securitySchemes?: Record<string, SecuritySchemeObject>;
    examples?: Record<string, ExampleObject | { $ref: string }>;
    links?: Record<string, unknown>;
    callbacks?: Record<string, unknown>;
    pathItems?: Record<string, PathItemObject>;
  };
  security?: SecurityRequirementObject[];
  tags?: TagObject[];
  externalDocs?: ExternalDocumentationObject;
}

export interface ConversionWarning {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

export interface ConvertedSchema {
  readonly schema: OasSchema;
  readonly warnings: ConversionWarning[];
}

export interface ConvertedDocument {
  readonly document: OpenApiDocument;
  readonly warnings: ConversionWarning[];
}

export interface DocumentInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}
