/**
 * `@minostack/mino/response-time` — elapsed-time response header middleware.
 *
 * Zero dependencies, runtime-agnostic (`performance.now()` + Fetch `Response` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { responseTime } from "@minostack/mino/response-time";
 *
 * const app = new Mino();
 * app.use(responseTime());
 * ```
 *
 * Measures the downstream chain with `performance.now()` and sets the header
 * (default `x-response-time`, e.g. `12.345ms`) on the rebuilt response. The
 * header is added regardless of downstream status (2xx/4xx/5xx alike). When no
 * downstream response exists the middleware is a no-op. Nothing is logged
 * (no secrets/PII handling involved).
 */

import type { Handler } from "./types.js";

export interface ResponseTimeOptions {
  /** Header to set (default `"x-response-time"`). */
  header?: string;
}

export function responseTime(opts: ResponseTimeOptions = {}): Handler {
  const header = opts.header ?? "x-response-time";
  return async (c, next) => {
    const start = performance.now();
    await next();
    const res = c.res;
    if (!res) return;
    // Rebuild is required: Fetch Response headers are immutable.
    const h = new Headers(res.headers);
    h.set(header, `${(performance.now() - start).toFixed(3)}ms`);
    // NOTE: must RETURN the rebuilt response — compose() prefers nextResult
    // over c.res, so setResponse alone would be discarded by the dispatcher.
    const out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: h,
    });
    c.setResponse(out);
    return out;
  };
}
