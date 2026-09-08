/**
 * OpenAPI integration for @minostack/mino — generates a complete document from the HTTP route graph.
 * Per §9.3: derives from Routes + Schemas + Metadata + Responses + Parameters + Security.
 */

import type { Schema } from "@minostack/schema";
import { document31, document30 } from "./oas.js";
import type {
  ConvertedDocument,
  DocumentInfo,
  DocumentOptions,
  MediaTypeInput,
  OperationInput,
  PathsInput,
  PathItemInput,
} from "./types.js";

// Minimal Mino app interface — duck-typed to avoid hard dependency
export type MinoApp = {
  getRoutes(): readonly { method: string; path: string; handlers: readonly unknown[] }[];
};

export type MinoRouteOperation = {
  input?: Schema<unknown, unknown>;
  output?: Schema<unknown, unknown>;
  operation?: OperationInput;
  description?: string;
};

export type MinoDocumentOptions = DocumentOptions & {
  /**
   * Map of route key ("GET /users/:id") to operation metadata.
   * If not provided, routes will be emitted with empty operations.
   */
  routeMap?: Map<string, MinoRouteOperation> | Record<string, MinoRouteOperation>;
  /**
   * Whether to derive schemas from routeMap's input/output.
   */
  autoSchemas?: boolean;
  /**
   * OpenAPI version — 3.1 by default
   */
  version?: "3.1" | "3.0";
};

function minoPathToOpenApi(path: string): string {
  // Convert :param to {param}, * to {wildcard}, handle edge
  return path
    .replace(/:([^/]+)/g, "{$1}")
    .replace(/\*/g, "{wildcard}")
    .replace(/\/+/g, "/");
}

function getRouteMapEntry(
  map: Map<string, MinoRouteOperation> | Record<string, MinoRouteOperation> | undefined,
  method: string,
  path: string,
): MinoRouteOperation | undefined {
  if (!map) return undefined;
  const key = `${method} ${path}`;
  const key2 = `${method.toUpperCase()} ${path}`;
  const key3 = `${method.toLowerCase()} ${path}`;
  if (map instanceof Map) return map.get(key) ?? map.get(key2) ?? map.get(key3);
  return (
    (map as Record<string, MinoRouteOperation>)[key] ??
    (map as Record<string, MinoRouteOperation>)[key2] ??
    (map as Record<string, MinoRouteOperation>)[key3]
  );
}

/**
 * Generate an OpenAPI document from a Mino app's route graph.
 * Schemas + routes + metadata are combined per §9.3.
 *
 * ```ts
 * const app = new Mino()
 * app.get("/users/:id", handler)
 * app.post("/users", validator("json", CreateUser), handler)
 *
 * const { document } = generateMinoDocument(app, { title: "API", version: "1.0" }, {
 *   User: UserSchema
 * }, {
 *   routeMap: {
 *     "GET /users/:id": { output: UserSchema, operation: { summary: "Get user", tags: ["Users"] } },
 *     "POST /users": { input: CreateUser, output: UserSchema }
 *   }
 * })
 * ```
 */
export function generateMinoDocument(
  app: MinoApp,
  info: DocumentInfo,
  schemas: Record<string, Schema<unknown, unknown>> = {},
  options: MinoDocumentOptions = {},
): ConvertedDocument {
  const { routeMap, autoSchemas = true, version = "3.1", ...docOptions } = options;

  const paths: PathsInput = { ...(docOptions.paths ?? {}) };
  const collectedSchemas: Record<string, Schema<unknown, unknown>> = { ...schemas };
  let autoCounter = 0;

  for (const route of app.getRoutes()) {
    const oasPath = minoPathToOpenApi(route.path);
    const method = route.method.toLowerCase() as keyof PathItemInput;
    // Only handle standard methods
    if (!["get", "post", "put", "delete", "patch", "options", "head", "trace"].includes(method))
      continue;

    const entry = getRouteMapEntry(routeMap, route.method, route.path);
    const operation: OperationInput = { ...(entry?.operation ?? {}) };

    // If input schema provided and autoSchemas enabled, add as requestBody with proper merge
    if (entry?.input && autoSchemas) {
      const name = `AutoInput${++autoCounter}`;
      // Register in collectedSchemas for components reuse (also keeps inline for v0.1)
      if (!(name in collectedSchemas)) collectedSchemas[name] = entry.input;
      const existingBody = operation.requestBody as
        | { content?: Record<string, MediaTypeInput>; description?: string; required?: boolean }
        | undefined;
      const existingContent = existingBody?.content ?? {};
      operation.requestBody = {
        ...(existingBody ?? {}),
        content: {
          ...existingContent,
          "application/json": { schema: entry.input },
        },
      } as OperationInput["requestBody"];
    }
    if (entry?.output && autoSchemas) {
      const existingResponses = operation.responses as
        | Record<string, { description: string; content?: Record<string, MediaTypeInput> }>
        | undefined;
      // Only add default 200 if not already present
      if (!existingResponses?.["200"]) {
        const outName = `AutoOutput${++autoCounter}`;
        if (!(outName in collectedSchemas)) collectedSchemas[outName] = entry.output;
        operation.responses = {
          "200": {
            description: "Success",
            content: { "application/json": { schema: entry.output } },
          },
          ...(existingResponses ?? {}),
        } as OperationInput["responses"];
      }
    }
    // Ensure at least a default response if none
    if (!operation.responses) {
      operation.responses = { "200": { description: "Success" } };
    }
    // Add summary default
    if (!operation.summary) operation.summary = `${route.method} ${route.path}`;

    // Merge into paths
    const existing = (paths[oasPath] ?? {}) as PathItemInput;
    (existing as Record<string, unknown>)[method] = operation;
    paths[oasPath] = existing;
  }

  const docOptionsWithPaths: DocumentOptions = {
    ...docOptions,
    paths,
  };

  if (version === "3.0") return document30(info, collectedSchemas, docOptionsWithPaths);
  return document31(info, collectedSchemas, docOptionsWithPaths);
}

/**
 * Alias for backwards compatibility — per prompt `openapi.generate(app)`
 */
export const generate = generateMinoDocument;

/**
 * Convert a single schema via OAS 3.1.
 */
export { oas31 as fromSchema, document31 as generateDocument } from "./oas.js";
