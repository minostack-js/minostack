/**
 * `@minostack/mino/powered-by` — `X-Powered-By` response header middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Headers`/`Response` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { poweredBy } from "@minostack/mino/powered-by";
 *
 * const app = new Mino();
 * app.use(poweredBy());
 * ```
 *
 * After `next()`, sets `x-powered-by` (default `"Mino"`) only when the handler
 * did not set one already — explicit route headers always win (helmet-style).
 * `poweredBy(false)` removes the header instead (hides the fingerprint when a
 * downstream layer set one). When no downstream response exists the middleware
 * is a no-op. Nothing is logged (no secrets/PII handling involved).
 */

import type { Handler } from "./types.js";

export function poweredBy(name: string | false = "Mino"): Handler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (!res) return;
    // Rebuild is required: Fetch Response headers are immutable.
    const h = new Headers(res.headers);
    if (name === false) {
      h.delete("x-powered-by");
    } else if (!h.has("x-powered-by")) {
      h.set("x-powered-by", name);
    }
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
