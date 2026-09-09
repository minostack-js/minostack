/**
 * OpenAPI security-scheme conveniences + route compatibility checks.
 * Per plan P4.3/P4.4: auth metadata for operations and versioned documents,
 * plus dev-mode breaking-change detection between route graphs.
 */

import type { SecurityRequirementObject, SecuritySchemeObject } from "./types.js";

export interface SecurityFragment {
  /** Spread into `DocumentOptions.components.securitySchemes` */
  securitySchemes: Record<string, SecuritySchemeObject>;
  /** Spread into an operation's `security` (routeMap entries) */
  security: SecurityRequirementObject[];
}

/** HTTP bearer (JWT/PASETO) scheme fragment. */
export function bearerAuth(schemeName = "bearerAuth", scheme: string = "bearer"): SecurityFragment {
  return {
    securitySchemes: { [schemeName]: { type: "http", scheme } },
    security: [{ [schemeName]: [] }],
  };
}

/** API-key scheme fragment (`in`: header/query/cookie, `name`: parameter name). */
export function apiKeyAuth(
  name: string,
  where: "header" | "query" | "cookie" = "header",
  schemeName = "apiKeyAuth",
): SecurityFragment {
  return {
    securitySchemes: { [schemeName]: { type: "apiKey", name, in: where } },
    security: [{ [schemeName]: [] }],
  };
}

/** OpenID Connect discovery fragment. */
export function oidcAuth(openIdConnectUrl: string, schemeName = "oidc"): SecurityFragment {
  return {
    securitySchemes: { [schemeName]: { type: "openIdConnect", openIdConnectUrl } },
    security: [{ [schemeName]: [] }],
  };
}

/** OAuth2 fragment with the flows the preview supports. */
export function oauth2Auth(
  flows: SecuritySchemeObject["flows"],
  schemeName = "oauth2",
): SecurityFragment {
  return {
    securitySchemes: { [schemeName]: { type: "oauth2", flows } },
    security: [{ [schemeName]: [] }],
  };
}

// ─────────────────────────────────────────────────────────────────
// Compatibility — diff two route graphs (e.g. v1 vs v2, or before/after)
// ─────────────────────────────────────────────────────────────────

export interface RouteRef {
  method: string;
  path: string;
}

export interface RouteDiff {
  /** Removed method+path entries — breaking for clients */
  breaking: string[];
  /** Added method+path entries — safe additive surface */
  additive: string[];
  /** Entries present in both graphs */
  unchanged: number;
}

function routeKey(r: RouteRef): string {
  return `${r.method.toUpperCase()} ${r.path}`;
}

/**
 * Compare route graphs. Removed routes are breaking; added routes are
 * additive. Operates on method+path only (no network, no schema walking) —
 * pair with schema review for tightened-validation detection.
 */
export function diffRoutes(prev: readonly RouteRef[], next: readonly RouteRef[]): RouteDiff {
  const before = new Set(prev.map(routeKey));
  const after = new Set(next.map(routeKey));
  const breaking: string[] = [];
  const additive: string[] = [];
  let unchanged = 0;
  for (const key of before) {
    if (after.has(key)) unchanged++;
    else breaking.push(`removed ${key}`);
  }
  for (const key of after) {
    if (!before.has(key)) additive.push(`added ${key}`);
  }
  return { breaking, additive, unchanged };
}

/**
 * Assert compatibility in tests/CI: throws on breaking changes, returns the
 * additive report otherwise.
 */
export function assertCompatible(prev: readonly RouteRef[], next: readonly RouteRef[]): string[] {
  const diff = diffRoutes(prev, next);
  if (diff.breaking.length > 0) {
    throw new Error(`Breaking API changes:\n${diff.breaking.map((b) => `  - ${b}`).join("\n")}`);
  }
  return diff.additive;
}
