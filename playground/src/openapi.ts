/**
 * In-depth reference: `@minostack/openapi`. `oas31` converts one schema to an
 * OAS 3.1 Schema Object; `document31` wraps named roots in a full document
 * (required for recursive schemas). Approximations are never silent — every
 * one adds a machine-readable warning `{ code, path, message }`.
 */

import { document31, oas30, oas31 } from "@minostack/openapi";
import { User } from "./user.js";
import { Category } from "./recursive.js";

export interface OpenApiSummary {
  readonly openapiVersion: string;
  readonly componentNames: readonly string[];
  readonly trimsToString: boolean;
  readonly legacyIsObject: boolean;
  readonly warningCodes: readonly string[];
}

export function run(): OpenApiSummary {
  const slim = oas31(User.pick({ id: true, name: true }));
  const legacy = oas30(User);
  const document = document31({ title: "Playground API", version: "0.0.0" }, { User, Category });
  const codes = new Set<string>();
  for (const result of [slim, legacy, document]) {
    for (const warning of result.warnings) {
      codes.add(warning.code);
    }
  }
  return {
    openapiVersion: document.document.openapi,
    componentNames: Object.keys(document.document.components.schemas),
    trimsToString: slim.schema.properties?.["name"]?.type === "string",
    legacyIsObject: legacy.schema.type === "object",
    warningCodes: [...codes],
  };
}
