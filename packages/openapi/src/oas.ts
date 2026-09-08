/**
 * MinoStack schema → OpenAPI 3.1 / 3.0 converter.
 *
 * One parameterized engine; 3.1 and 3.0 differ only in lowering helpers.
 * Every node kind converts. Anything without a native representation converts
 * to its closest shape PLUS a machine-readable warning — nothing is silently
 * lost. See the package README for the full kind × version mapping table.
 *
 * Two entry styles:
 * - `oas31(schema)` / `oas30(schema)` — standalone Schema Object. Recursive
 *   schemas cannot be inlined and throw; use `document31`/`document30`.
 * - `document31(info, { Name: schema })` / `document30(...)` — full document
 *   with `components.schemas`, `$ref` deduplication, and discriminator mappings.
 * - `document31(info, schemas, options)` — enterprise builder with `paths`,
 *   `components` (responses/parameters/securitySchemes), `servers`, `tags`,
 *   `security`, `webhooks` (3.1 only) and `externalDocs`.
 */

import type {
  DiscriminatedUnionNode,
  ObjectNode,
  RecordNode,
  Schema,
  SchemaNode,
  UnionNode,
} from "@minostack/schema";
import type {
  ComponentsInput,
  ConversionWarning,
  ConvertedDocument,
  ConvertedSchema,
  DocumentInfo,
  DocumentOptions,
  ExampleObject,
  HeaderObject,
  MediaTypeInput,
  MediaTypeObject,
  OasSchema,
  OpenApiDocument,
  OpenApiVersion,
  OperationInput,
  OperationObject,
  ParameterInputOrRef,
  ParameterObject,
  PathItemInput,
  PathItemObject,
  PathsInput,
  RequestBodyInputOrRef,
  RequestBodyObject,
  ResponseInputOrRef,
  ResponseObject,
  SchemaInput,
  SecuritySchemeObject,
  WebhooksInput,
} from "./types.js";

interface Context {
  readonly version: OpenApiVersion;
  readonly warnings: ConversionWarning[];
  readonly defs: Map<SchemaNode, string>;
  readonly active: SchemaNode[];
}

function warn(ctx: Context, path: readonly PropertyKey[], code: string, message: string): void {
  ctx.warnings.push({ path: [...path], code, message });
}

function escapePointer(name: string): string {
  return name.replace(/~/g, "~0").replace(/\//g, "~1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Assignment safe for hostile keys such as `__proto__`. */
function setProp<T>(target: Record<string, T>, key: string, value: T): void {
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

/** Detect a `@minostack/schema` Schema instance (has `.node.kind`). */
function isSchema(value: unknown): value is Schema<unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "node" in value &&
    typeof (value as { node: unknown }).node === "object" &&
    (value as { node: unknown }).node !== null &&
    typeof (value as { node: { kind: unknown } }).node.kind === "string"
  );
}

function isRef(value: unknown): value is { $ref: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as { $ref: unknown }).$ref === "string"
  );
}

function toOasSchema(
  input: SchemaInput,
  ctx: Context,
  path: readonly PropertyKey[],
): OasSchema | { $ref: string } {
  if (isRef(input)) return input;
  if (isSchema(input)) return convert((input as Schema<unknown, unknown>).node, ctx, path, false);
  return input as OasSchema;
}

function convertMediaType(
  input: MediaTypeInput,
  ctx: Context,
  path: readonly PropertyKey[],
): MediaTypeObject {
  const out: MediaTypeObject = {};
  if (input.schema !== undefined) {
    out.schema = toOasSchema(input.schema, ctx, [...path, "schema"]);
  }
  if (input.example !== undefined) out.example = input.example;
  if (input.examples !== undefined) out.examples = input.examples;
  if (input.encoding !== undefined) out.encoding = input.encoding;
  return out;
}

function convertContentMap(
  content: Record<string, MediaTypeInput>,
  ctx: Context,
  path: readonly PropertyKey[],
): Record<string, MediaTypeObject> {
  const out: Record<string, MediaTypeObject> = {};
  for (const [mediaType, media] of Object.entries(content)) {
    setProp(out, mediaType, convertMediaType(media, ctx, [...path, mediaType]));
  }
  return out;
}

function convertRequestBody(
  input: RequestBodyInputOrRef,
  ctx: Context,
  path: readonly PropertyKey[],
): RequestBodyObject | { $ref: string } {
  if (isRef(input)) return input;
  const out: RequestBodyObject = {
    content: convertContentMap(
      (input as { content: Record<string, MediaTypeInput> }).content,
      ctx,
      [...path, "content"],
    ),
  };
  const src = input as { description?: string; required?: boolean };
  if (src.description !== undefined) out.description = src.description;
  if (src.required !== undefined) out.required = src.required;
  return out;
}

function convertResponse(
  input: ResponseInputOrRef,
  ctx: Context,
  path: readonly PropertyKey[],
): ResponseObject | { $ref: string } {
  if (isRef(input)) return input;
  const src = input as {
    description: string;
    headers?: unknown;
    content?: Record<string, MediaTypeInput>;
    links?: unknown;
  };
  const out: ResponseObject = { description: src.description };
  if (src.headers !== undefined)
    out.headers = src.headers as Record<string, unknown> as ResponseObject["headers"];
  if (src.content !== undefined)
    out.content = convertContentMap(src.content, ctx, [...path, "content"]);
  if (src.links !== undefined) out.links = src.links as ResponseObject["links"];
  return out;
}

function convertParameter(
  input: ParameterInputOrRef,
  ctx: Context,
  path: readonly PropertyKey[],
): ParameterObject | { $ref: string } {
  if (isRef(input)) return input;
  const src = input as {
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
    examples?: Record<string, unknown>;
    content?: Record<string, MediaTypeInput>;
  };
  const out: ParameterObject = { name: src.name, in: src.in };
  if (src.description !== undefined) out.description = src.description;
  if (src.required !== undefined) out.required = src.required;
  if (src.deprecated !== undefined) out.deprecated = src.deprecated;
  if (src.allowEmptyValue !== undefined) out.allowEmptyValue = src.allowEmptyValue;
  if (src.style !== undefined) out.style = src.style;
  if (src.explode !== undefined) out.explode = src.explode;
  if (src.allowReserved !== undefined) out.allowReserved = src.allowReserved;
  if (src.schema !== undefined) out.schema = toOasSchema(src.schema, ctx, [...path, "schema"]);
  if (src.example !== undefined) out.example = src.example;
  if (src.examples !== undefined) out.examples = src.examples as ParameterObject["examples"];
  if (src.content !== undefined)
    out.content = convertContentMap(src.content, ctx, [...path, "content"]);
  return out;
}

function convertOperation(
  input: OperationInput,
  ctx: Context,
  path: readonly PropertyKey[],
): OperationObject {
  const out: OperationObject = {};
  if (input.tags !== undefined) out.tags = [...input.tags];
  if (input.summary !== undefined) out.summary = input.summary;
  if (input.description !== undefined) out.description = input.description;
  if (input.externalDocs !== undefined) out.externalDocs = input.externalDocs;
  if (input.operationId !== undefined) out.operationId = input.operationId;
  if (input.parameters !== undefined) {
    out.parameters = input.parameters.map((p, i) =>
      convertParameter(p, ctx, [...path, "parameters", i]),
    );
  }
  if (input.requestBody !== undefined) {
    out.requestBody = convertRequestBody(input.requestBody, ctx, [...path, "requestBody"]);
  }
  if (input.responses !== undefined) {
    const responses: Record<string, ResponseObject | { $ref: string }> = {};
    for (const [code, resp] of Object.entries(input.responses)) {
      setProp(
        responses,
        code,
        convertResponse(resp as ResponseInputOrRef, ctx, [...path, "responses", code]),
      );
    }
    out.responses = responses;
  }
  if (input.callbacks !== undefined) out.callbacks = input.callbacks;
  if (input.deprecated !== undefined) out.deprecated = input.deprecated;
  if (input.security !== undefined) out.security = input.security;
  if (input.servers !== undefined) out.servers = input.servers;
  return out;
}

function convertPathItem(
  input: PathItemInput,
  ctx: Context,
  path: readonly PropertyKey[],
): PathItemObject {
  const out: PathItemObject = {};
  if (input.summary !== undefined) out.summary = input.summary;
  if (input.description !== undefined) out.description = input.description;
  if (input.servers !== undefined) out.servers = input.servers;
  if (input.parameters !== undefined) {
    out.parameters = input.parameters.map((p, i) =>
      convertParameter(p, ctx, [...path, "parameters", i]),
    );
  }
  const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
  for (const method of methods) {
    const op = (input as Record<string, unknown>)[method] as OperationInput | undefined;
    if (op !== undefined) {
      (out as Record<string, unknown>)[method] = convertOperation(op, ctx, [...path, method]);
    }
  }
  return out;
}

function convertPaths(paths: PathsInput, ctx: Context): Record<string, PathItemObject> {
  const out: Record<string, PathItemObject> = {};
  for (const [p, item] of Object.entries(paths)) {
    setProp(out, p, convertPathItem(item, ctx, ["paths", p]));
  }
  return out;
}

function convertWebhooks(webhooks: WebhooksInput, ctx: Context): Record<string, PathItemObject> {
  const out: Record<string, PathItemObject> = {};
  for (const [name, item] of Object.entries(webhooks)) {
    setProp(out, name, convertPathItem(item, ctx, ["webhooks", name]));
  }
  return out;
}

function convertComponents(
  components: ComponentsInput | undefined,
  ctx: Context,
  pathPrefix: string,
): {
  responses?: Record<string, ResponseObject | { $ref: string }>;
  parameters?: Record<string, ParameterObject | { $ref: string }>;
  requestBodies?: Record<string, RequestBodyObject | { $ref: string }>;
  headers?: Record<string, unknown>;
  securitySchemes?: Record<string, SecuritySchemeObject>;
  examples?: Record<string, unknown>;
  links?: Record<string, unknown>;
  callbacks?: Record<string, unknown>;
  pathItems?: Record<string, PathItemObject>;
} {
  if (components === undefined) return {};
  const out: Record<string, unknown> = {};
  if (components.responses !== undefined) {
    const map: Record<string, ResponseObject | { $ref: string }> = {};
    for (const [k, v] of Object.entries(components.responses)) {
      setProp(map, k, convertResponse(v, ctx, [pathPrefix, "responses", k]));
    }
    out["responses"] = map;
  }
  if (components.parameters !== undefined) {
    const map: Record<string, ParameterObject | { $ref: string }> = {};
    for (const [k, v] of Object.entries(components.parameters)) {
      setProp(map, k, convertParameter(v, ctx, [pathPrefix, "parameters", k]));
    }
    out["parameters"] = map;
  }
  if (components.requestBodies !== undefined) {
    const map: Record<string, RequestBodyObject | { $ref: string }> = {};
    for (const [k, v] of Object.entries(components.requestBodies)) {
      setProp(map, k, convertRequestBody(v, ctx, [pathPrefix, "requestBodies", k]));
    }
    out["requestBodies"] = map;
  }
  if (components.headers !== undefined) out["headers"] = components.headers;
  if (components.securitySchemes !== undefined) out["securitySchemes"] = components.securitySchemes;
  if (components.examples !== undefined) out["examples"] = components.examples;
  if (components.links !== undefined) out["links"] = components.links;
  if (components.callbacks !== undefined) out["callbacks"] = components.callbacks;
  if (components.pathItems !== undefined) {
    const map: Record<string, PathItemObject> = {};
    for (const [k, v] of Object.entries(components.pathItems)) {
      setProp(map, k, convertPathItem(v, ctx, [pathPrefix, "pathItems", k]));
    }
    out["pathItems"] = map;
  }
  return out as {
    responses?: Record<string, ResponseObject | { $ref: string }>;
    parameters?: Record<string, ParameterObject | { $ref: string }>;
    requestBodies?: Record<string, RequestBodyObject | { $ref: string }>;
    headers?: Record<string, unknown>;
    securitySchemes?: Record<string, SecuritySchemeObject>;
    examples?: Record<string, unknown>;
    links?: Record<string, unknown>;
    callbacks?: Record<string, unknown>;
    pathItems?: Record<string, PathItemObject>;
  };
}

/** Static "accepts undefined" analysis for `required` computation. */
function acceptsUndefined(node: SchemaNode, seen: Set<SchemaNode>): boolean {
  switch (node.kind) {
    case "optional":
    case "default":
    case "any":
    case "unknown":
    case "undefined":
      return true;
    case "literal":
      return node.value === undefined;
    case "nullable":
    case "refine":
    case "transform":
      return acceptsUndefined(node.inner, seen);
    case "union":
      return node.variants.some((variant) => acceptsUndefined(variant, seen));
    case "lazy": {
      if (seen.has(node)) {
        return false;
      }
      seen.add(node);
      try {
        return acceptsUndefined(node.resolve(), seen);
      } finally {
        seen.delete(node);
      }
    }
    default:
      return false;
  }
}

function isSafeNumber(value: bigint): boolean {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

function toJson(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return { ok: false };
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(value)) as unknown };
  } catch {
    return { ok: false };
  }
}

function defaultValue(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value === "bigint") {
    return isSafeNumber(value) ? { ok: true, value: Number(value) } : { ok: false };
  }
  return toJson(value);
}

function applyMeta(
  target: OasSchema,
  node: SchemaNode,
  ctx: Context,
  path: readonly PropertyKey[],
): void {
  const meta = node.metadata;
  if (meta.title !== undefined) {
    target.title = meta.title;
  }
  if (meta.description !== undefined) {
    target.description = meta.description;
  }
  if (meta.deprecated === true || typeof meta.deprecated === "string") {
    target.deprecated = true;
  }
  if (meta.examples !== undefined && meta.examples.length > 0) {
    const values: unknown[] = [];
    for (const example of meta.examples) {
      const json = toJson(example);
      if (json.ok) {
        values.push(json.value);
      } else {
        warn(
          ctx,
          path,
          "nonserializable-example",
          "Example value is not JSON-serializable and was dropped.",
        );
      }
    }
    if (values.length > 0) {
      if (ctx.version === "3.1") {
        target.examples = values;
      } else {
        target.example = values[0];
      }
    }
  }
}

function applyDefault(
  target: OasSchema,
  value: unknown,
  ctx: Context,
  path: readonly PropertyKey[],
): void {
  const json = defaultValue(value);
  if (json.ok) {
    target.default = json.value;
  } else {
    warn(
      ctx,
      path,
      "nonserializable-default",
      "Default value is not JSON-serializable and was omitted.",
    );
  }
}

function applyNullable(target: OasSchema, version: OpenApiVersion): OasSchema {
  if (version === "3.1") {
    if (typeof target.type === "string") {
      return { ...target, type: [target.type, "null"] };
    }
    return { anyOf: [target, { type: "null" }] };
  }
  if (target.$ref !== undefined && Object.keys(target).length === 1) {
    return { allOf: [target], nullable: true };
  }
  return { ...target, nullable: true };
}

function applyBounds(
  target: OasSchema,
  op: "gte" | "lte" | "gt" | "lt",
  bound: number,
  version: OpenApiVersion,
): void {
  if (op === "gte") {
    target.minimum = bound;
  } else if (op === "lte") {
    target.maximum = bound;
  } else if (op === "gt") {
    if (version === "3.1") {
      target.exclusiveMinimum = bound;
    } else {
      target.minimum = bound;
      target.exclusiveMinimum = true;
    }
  } else if (version === "3.1") {
    target.exclusiveMaximum = bound;
  } else {
    target.maximum = bound;
    target.exclusiveMaximum = true;
  }
}

function convertInner(node: SchemaNode, ctx: Context, path: readonly PropertyKey[]): OasSchema {
  const v31 = ctx.version === "3.1";
  switch (node.kind) {
    case "string": {
      const target: OasSchema = { type: "string" };
      for (const check of node.checks) {
        switch (check.kind) {
          case "min":
            target.minLength = check.value;
            break;
          case "max":
            target.maxLength = check.value;
            break;
          case "length":
            target.minLength = check.value;
            target.maxLength = check.value;
            break;
          case "email":
            target.format = "email";
            break;
          case "url":
            target.format = "uri";
            break;
          case "uuid":
            target.format = "uuid";
            break;
          case "datetime":
            target.format = "date-time";
            break;
          case "regex":
            target.pattern = check.pattern.source;
            break;
          case "startsWith":
            target.pattern = `^${escapeRegExp(check.value)}`;
            break;
          case "endsWith":
            target.pattern = `${escapeRegExp(check.value)}$`;
            break;
          case "includes":
            target.pattern = escapeRegExp(check.value);
            break;
          case "trim":
          case "toLowerCase":
          case "toUpperCase":
            warn(
              ctx,
              path,
              "normalizer-dropped",
              `String normalizer "${check.kind}" changes values and has no OpenAPI representation.`,
            );
            break;
        }
      }
      return target;
    }
    case "number": {
      const target: OasSchema = {};
      let integer = false;
      for (const check of node.checks) {
        switch (check.kind) {
          case "min":
            applyBounds(target, "gte", check.value, ctx.version);
            break;
          case "max":
            applyBounds(target, "lte", check.value, ctx.version);
            break;
          case "gt":
            applyBounds(target, "gt", check.value, ctx.version);
            break;
          case "gte":
            applyBounds(target, "gte", check.value, ctx.version);
            break;
          case "lt":
            applyBounds(target, "lt", check.value, ctx.version);
            break;
          case "lte":
            applyBounds(target, "lte", check.value, ctx.version);
            break;
          case "multipleOf":
            target.multipleOf = check.value;
            break;
          case "int":
          case "safe":
            integer = true;
            break;
          case "finite":
            break;
        }
      }
      target.type = integer ? "integer" : "number";
      return target;
    }
    case "bigint": {
      const target: OasSchema = { type: "integer", format: "int64" };
      for (const check of node.checks) {
        switch (check.kind) {
          case "min":
          case "gte":
            if (isSafeNumber(check.value)) {
              applyBounds(target, "gte", Number(check.value), ctx.version);
            } else {
              warn(
                ctx,
                path,
                "bigint-bound-omitted",
                "Bigint bound exceeds safe JSON numbers and was omitted.",
              );
            }
            break;
          case "max":
          case "lte":
            if (isSafeNumber(check.value)) {
              applyBounds(target, "lte", Number(check.value), ctx.version);
            } else {
              warn(
                ctx,
                path,
                "bigint-bound-omitted",
                "Bigint bound exceeds safe JSON numbers and was omitted.",
              );
            }
            break;
          case "gt":
            if (isSafeNumber(check.value)) {
              applyBounds(target, "gt", Number(check.value), ctx.version);
            } else {
              warn(
                ctx,
                path,
                "bigint-bound-omitted",
                "Bigint bound exceeds safe JSON numbers and was omitted.",
              );
            }
            break;
          case "lt":
            if (isSafeNumber(check.value)) {
              applyBounds(target, "lt", Number(check.value), ctx.version);
            } else {
              warn(
                ctx,
                path,
                "bigint-bound-omitted",
                "Bigint bound exceeds safe JSON numbers and was omitted.",
              );
            }
            break;
          case "multipleOf":
            if (isSafeNumber(check.value)) {
              target.multipleOf = Number(check.value);
            } else {
              warn(
                ctx,
                path,
                "bigint-bound-omitted",
                "Bigint multipleOf exceeds safe JSON numbers and was omitted.",
              );
            }
            break;
        }
      }
      return target;
    }
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "literal": {
      const value = node.value;
      if (value === undefined) {
        warn(
          ctx,
          path,
          "undefined-literal",
          "m.literal(undefined) has no JSON representation; emitted unconstrained.",
        );
        return {};
      }
      if (typeof value === "bigint") {
        if (isSafeNumber(value)) {
          return v31 ? { const: Number(value) } : { type: "integer", enum: [Number(value)] };
        }
        warn(
          ctx,
          path,
          "bigint-bound-omitted",
          "Bigint literal exceeds safe JSON numbers; emitted as int64 without const.",
        );
        return { type: "integer", format: "int64" };
      }
      if (v31) {
        return { const: value };
      }
      if (value === null) {
        return { enum: [null] };
      }
      const type =
        typeof value === "string"
          ? "string"
          : typeof value === "boolean"
            ? "boolean"
            : Number.isInteger(value)
              ? "integer"
              : "number";
      return { type, enum: [value] };
    }
    case "enum":
      return { type: "string", enum: [...node.values] };
    case "null":
      return v31 ? { type: "null" } : { enum: [null] };
    case "undefined":
      warn(
        ctx,
        path,
        "undefined-literal",
        "m.undefined() has no JSON representation; emitted unconstrained.",
      );
      return {};
    case "any":
    case "unknown":
      return {};
    case "never":
      return { not: {} };
    case "object":
      return convertObject(node, ctx, path);
    case "array": {
      const target: OasSchema = {
        type: "array",
        items: convert(node.element, ctx, [...path, "*"], false),
      };
      for (const check of node.checks) {
        if (check.kind === "min") {
          target.minItems = check.value;
        } else if (check.kind === "max") {
          target.maxItems = check.value;
        } else {
          target.minItems = check.value;
          target.maxItems = check.value;
        }
      }
      return target;
    }
    case "tuple": {
      const items = node.items.map((item, index) => convert(item, ctx, [...path, index], false));
      if (v31) {
        return {
          type: "array",
          prefixItems: items,
          minItems: items.length,
          maxItems: items.length,
        };
      }
      warn(
        ctx,
        path,
        "tuple-positions-lost",
        "OpenAPI 3.0 has no prefixItems; tuple positions degrade to an anyOf union.",
      );
      return {
        type: "array",
        items: { anyOf: items },
        minItems: items.length,
        maxItems: items.length,
      };
    }
    case "record":
      return convertRecord(node, ctx, path);
    case "union":
      return convertUnion(node, ctx, path);
    case "discriminatedUnion":
      return convertDiscriminatedUnion(node, ctx, path);
    case "intersection":
      return {
        allOf: [convert(node.left, ctx, path, false), convert(node.right, ctx, path, false)],
      };
    case "optional":
      return convert(node.inner, ctx, path, false);
    case "nullable":
      return applyNullable(convert(node.inner, ctx, path, false), ctx.version);
    case "default": {
      const target = convert(node.inner, ctx, path, false);
      applyDefault(target, node.value, ctx, path);
      return target;
    }
    case "transform": {
      warn(
        ctx,
        path,
        "transform-input-side",
        "Transforms emit the input side; response shapes need their own schema.",
      );
      return convert(node.inner, ctx, path, false);
    }
    case "refine": {
      warn(
        ctx,
        path,
        "refinement-dropped",
        `Refinement (${node.refinements.length} predicate${node.refinements.length === 1 ? "" : "s"}) has no OpenAPI representation; emitted base type.`,
      );
      return convert(node.inner, ctx, path, false);
    }
    case "lazy":
      return convert(node.resolve(), ctx, path, false);
  }
}

function convertObject(node: ObjectNode, ctx: Context, path: readonly PropertyKey[]): OasSchema {
  const properties: Record<string, OasSchema> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(node.fields)) {
    setProp(properties, key, convert(field, ctx, [...path, key], false));
    if (!acceptsUndefined(field, new Set())) {
      required.push(key);
    }
  }
  const target: OasSchema = { type: "object", properties };
  if (required.length > 0) {
    target.required = required;
  }
  if (node.unknownKeys === "strict") {
    target.additionalProperties = false;
  } else if (node.unknownKeys === "passthrough") {
    target.additionalProperties = true;
  }
  return target;
}

function convertRecord(node: RecordNode, ctx: Context, path: readonly PropertyKey[]): OasSchema {
  const target: OasSchema = {
    type: "object",
    additionalProperties: convert(node.values, ctx, [...path, "*"], false),
  };
  const bareStringKeys =
    node.keys.kind === "string" &&
    node.keys.checks.length === 0 &&
    Object.keys(node.keys.metadata).length === 0;
  if (bareStringKeys) {
    return target;
  }
  if (node.keys.kind === "number") {
    warn(
      ctx,
      path,
      "property-names-dropped",
      "Numeric record keys have no propertyNames representation; key constraints dropped.",
    );
    return target;
  }
  if (ctx.version === "3.0") {
    warn(
      ctx,
      path,
      "property-names-dropped",
      "OpenAPI 3.0 has no propertyNames; record key constraints dropped.",
    );
    return target;
  }
  target.propertyNames = convert(node.keys, ctx, path, false);
  return target;
}

function convertUnion(node: UnionNode, ctx: Context, path: readonly PropertyKey[]): OasSchema {
  if (ctx.version === "3.0") {
    const isNullish = (variant: SchemaNode): boolean =>
      variant.kind === "null" ||
      variant.kind === "undefined" ||
      (variant.kind === "literal" && variant.value === null);
    if (node.variants.some(isNullish)) {
      const rest = node.variants.filter((variant) => !isNullish(variant));
      const base: OasSchema =
        rest.length === 1 && rest[0] !== undefined
          ? convert(rest[0], ctx, path, false)
          : { anyOf: rest.map((variant) => convert(variant, ctx, path, false)) };
      return { ...base, nullable: true };
    }
  }
  return { anyOf: node.variants.map((variant) => convert(variant, ctx, path, false)) };
}

function convertDiscriminatedUnion(
  node: DiscriminatedUnionNode,
  ctx: Context,
  path: readonly PropertyKey[],
): OasSchema {
  const oneOf: OasSchema[] = [];
  const mapping: Record<string, string> = {};
  for (const variant of node.variants) {
    const name = ctx.defs.get(variant.node);
    if (name !== undefined) {
      oneOf.push({ $ref: `#/components/schemas/${escapePointer(name)}` });
      setProp(mapping, variant.key, `#/components/schemas/${escapePointer(name)}`);
    } else {
      oneOf.push(convert(variant.node, ctx, path, false));
    }
  }
  const discriminator: { propertyName: string; mapping?: Record<string, string> } = {
    propertyName: node.discriminator,
  };
  if (Object.keys(mapping).length > 0) {
    discriminator.mapping = mapping;
  }
  return { oneOf, discriminator };
}

function convert(
  node: SchemaNode,
  ctx: Context,
  path: readonly PropertyKey[],
  isRoot: boolean,
): OasSchema {
  if (!isRoot) {
    const name = ctx.defs.get(node);
    if (name !== undefined) {
      return { $ref: `#/components/schemas/${escapePointer(name)}` };
    }
  }
  if (ctx.active.includes(node)) {
    throw new Error(
      "Recursive schema requires document31()/document30(): register it as a named component so cycles become $refs.",
    );
  }
  ctx.active.push(node);
  try {
    const target = convertInner(node, ctx, path);
    applyMeta(target, node, ctx, path);
    return target;
  } finally {
    ctx.active.pop();
  }
}

function freshContext(version: OpenApiVersion, defs?: Map<SchemaNode, string>): Context {
  return { version, warnings: [], defs: defs ?? new Map(), active: [] };
}

export function oas31(schema: Schema<unknown, unknown>): ConvertedSchema {
  const ctx = freshContext("3.1");
  return { schema: convert(schema.node, ctx, [], true), warnings: ctx.warnings };
}

export function oas30(schema: Schema<unknown, unknown>): ConvertedSchema {
  const ctx = freshContext("3.0");
  return { schema: convert(schema.node, ctx, [], true), warnings: ctx.warnings };
}

function buildDocument(
  version: OpenApiVersion,
  openapi: string,
  info: DocumentInfo,
  schemas: Record<string, Schema<unknown, unknown>>,
  options?: DocumentOptions,
): ConvertedDocument {
  // Merge schemas from second arg + options.components.schemas where the value is a Schema instance
  const allSchemas: Record<string, SchemaInput> = { ...schemas } as Record<string, SchemaInput>;
  if (options?.components?.schemas !== undefined) {
    for (const [k, v] of Object.entries(options.components.schemas)) {
      if (!(k in allSchemas)) {
        setProp(allSchemas as Record<string, SchemaInput>, k, v);
      }
    }
  }

  const defs = new Map<SchemaNode, string>();
  for (const name of Object.keys(allSchemas)) {
    const schema = (allSchemas as Record<string, SchemaInput>)[name];
    if (isSchema(schema)) {
      defs.set((schema as Schema<unknown, unknown>).node, name);
    }
  }

  const ctx = freshContext(version, defs);
  const componentsSchemas: Record<string, OasSchema> = {};

  for (const [name, schemaInput] of Object.entries(allSchemas)) {
    const before = ctx.warnings.length;
    let converted: OasSchema | { $ref: string };
    if (isSchema(schemaInput)) {
      converted = convert(
        (schemaInput as Schema<unknown, unknown>).node,
        ctx,
        [],
        true,
      ) as OasSchema;
    } else if (isRef(schemaInput)) {
      converted = schemaInput as { $ref: string };
    } else {
      converted = schemaInput as OasSchema;
    }
    setProp(componentsSchemas, name, converted as OasSchema);
    for (let i = before; i < ctx.warnings.length; i += 1) {
      const warning = ctx.warnings[i];
      if (warning !== undefined) {
        ctx.warnings[i] = { ...warning, path: [name, ...warning.path] };
      }
    }
  }

  // Paths
  let paths: Record<string, PathItemObject> = {};
  if (options?.paths !== undefined) {
    paths = convertPaths(options.paths, ctx);
  }

  // Webhooks (3.1 only)
  let webhooks: Record<string, PathItemObject> | undefined;
  if (options?.webhooks !== undefined) {
    if (version === "3.0") {
      warn(
        ctx,
        ["webhooks"],
        "webhooks-requires-3.1",
        "webhooks are OpenAPI 3.1 only and were omitted in 3.0 output.",
      );
    } else {
      webhooks = convertWebhooks(options.webhooks, ctx);
    }
  }

  // jsonSchemaDialect warning for 3.0
  if (options?.jsonSchemaDialect !== undefined && version === "3.0") {
    warn(
      ctx,
      ["jsonSchemaDialect"],
      "jsonSchemaDialect-requires-3.1",
      "jsonSchemaDialect is OpenAPI 3.1 only and was omitted in 3.0 output.",
    );
  }

  // Other components (responses, parameters, requestBodies, etc.)
  const otherComponents = convertComponents(options?.components, ctx, "components");

  // Merge components: schemas + other
  const components: OpenApiDocument["components"] = { schemas: componentsSchemas };
  if (otherComponents.responses !== undefined) components.responses = otherComponents.responses;
  if (otherComponents.parameters !== undefined) components.parameters = otherComponents.parameters;
  if (otherComponents.requestBodies !== undefined)
    components.requestBodies = otherComponents.requestBodies;
  if (otherComponents.headers !== undefined)
    components.headers = otherComponents.headers as Record<string, HeaderObject | { $ref: string }>;
  if (otherComponents.securitySchemes !== undefined)
    components.securitySchemes = otherComponents.securitySchemes;
  if (otherComponents.examples !== undefined)
    components.examples = otherComponents.examples as Record<
      string,
      ExampleObject | { $ref: string }
    >;
  if (otherComponents.links !== undefined) components.links = otherComponents.links;
  if (otherComponents.callbacks !== undefined) components.callbacks = otherComponents.callbacks;
  if (otherComponents.pathItems !== undefined) components.pathItems = otherComponents.pathItems;

  const document: OpenApiDocument = {
    openapi,
    info: {
      title: info.title,
      version: info.version,
      ...(info.description !== undefined ? { description: info.description } : {}),
    },
    ...(options?.jsonSchemaDialect !== undefined && version === "3.1"
      ? { jsonSchemaDialect: options.jsonSchemaDialect }
      : {}),
    ...(options?.servers !== undefined ? { servers: options.servers } : {}),
    paths,
    ...(webhooks !== undefined ? { webhooks } : {}),
    components,
    ...(options?.security !== undefined ? { security: options.security } : {}),
    ...(options?.tags !== undefined ? { tags: options.tags } : {}),
    ...(options?.externalDocs !== undefined ? { externalDocs: options.externalDocs } : {}),
  };

  return { document, warnings: ctx.warnings };
}

export function document31(
  info: DocumentInfo,
  schemas: Record<string, Schema<unknown, unknown>>,
  options?: DocumentOptions,
): ConvertedDocument {
  return buildDocument("3.1", "3.1.0", info, schemas, options);
}

export function document30(
  info: DocumentInfo,
  schemas: Record<string, Schema<unknown, unknown>>,
  options?: DocumentOptions,
): ConvertedDocument {
  return buildDocument("3.0", "3.0.3", info, schemas, options);
}
