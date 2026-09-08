/**
 * `@minostack/mino/cors` — Cross-Origin Resource Sharing middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Headers` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { cors } from "@minostack/mino/cors";
 *
 * const app = new Mino();
 * app.use(cors({ origin: ["https://app.example.com"], credentials: true }));
 * ```
 *
 * Behavior: requests without an `Origin` header pass through untouched.
 * Preflight (`OPTIONS` + `Access-Control-Request-Method`) is answered with
 * `204` directly and never reaches route handlers. Disallowed origins get no
 * `Access-Control-*` headers, so browsers block the read.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";

export interface CorsOptions {
  /**
   * Allowed origins. `true` reflects the request origin, `false`/unset allows
   * no origin (same-origin only). Arrays may mix exact strings and RegExp.
   * Default: `false`.
   */
  origin?:
    boolean | string | Array<string | RegExp> | RegExp | ((origin: string, c: Context) => boolean);
  /** Methods advertised on preflight (default common methods). */
  methods?: string[];
  /**
   * Headers advertised on preflight. Default: reflect the request's
   * `Access-Control-Request-Headers` (never `*` when credentials are on).
   */
  allowedHeaders?: string[];
  /** Headers exposed to browser JS via `Access-Control-Expose-Headers`. */
  exposedHeaders?: string[];
  /** Send `Access-Control-Allow-Credentials: true` (default false). */
  credentials?: boolean;
  /** `Access-Control-Max-Age` seconds for preflight caching. */
  maxAge?: number;
}

const DEFAULT_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"];

function isOriginAllowed(
  origin: string,
  rule: NonNullable<CorsOptions["origin"]>,
  c: Context,
): boolean {
  if (rule === true) return true;
  if (typeof rule === "string") return origin === rule;
  if (Array.isArray(rule)) {
    return rule.some((entry) => {
      if (typeof entry === "string") return origin === entry;
      entry.lastIndex = 0;
      return entry.test(origin);
    });
  }
  if (rule instanceof RegExp) {
    rule.lastIndex = 0;
    return rule.test(origin);
  }
  return (rule as (o: string, c: Context) => boolean)(origin, c);
}

export function cors(opts: CorsOptions = {}): Handler {
  const originRule = opts.origin ?? false;
  const methods = opts.methods ?? DEFAULT_METHODS;
  const credentials = opts.credentials ?? false;

  return async (c, next) => {
    const origin = c.header("origin");
    if (!origin) {
      await next();
      return;
    }
    const allowed =
      originRule !== false && isOriginAllowed(origin, originRule, c as unknown as Context);
    const vary = "Origin";

    if (c.method === "OPTIONS" && c.header("access-control-request-method")) {
      // Preflight — answer directly, routes never see it.
      const h = new Headers();
      if (allowed) {
        // Echo the validated origin (never `*`): safe with credentials on or off.
        h.set("access-control-allow-origin", origin);
        if (credentials) h.set("access-control-allow-credentials", "true");
        h.set("access-control-allow-methods", methods.join(", "));
        const reqHeaders = c.header("access-control-request-headers");
        if (opts.allowedHeaders)
          h.set("access-control-allow-headers", opts.allowedHeaders.join(", "));
        else if (reqHeaders) h.set("access-control-allow-headers", reqHeaders);
        if (opts.maxAge !== undefined) h.set("access-control-max-age", String(opts.maxAge));
      }
      h.set("vary", vary);
      c.setResponse(new Response(null, { status: 204, headers: h }));
      return;
    }

    await next();
    const res = c.res;
    if (!res || !allowed) return;
    const h = new Headers(res.headers);
    h.set("access-control-allow-origin", origin);
    if (credentials) h.set("access-control-allow-credentials", "true");
    if (opts.exposedHeaders) h.set("access-control-expose-headers", opts.exposedHeaders.join(", "));
    const prevVary = h.get("vary");
    h.set("vary", prevVary ? `${prevVary}, ${vary}` : vary);
    // NOTE: return (not just setResponse) — compose() prefers nextResult.
    const out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: h,
    });
    c.setResponse(out);
    return out;
  };
}
