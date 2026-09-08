/**
 * `@minostack/mino/helmet` — security response headers middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Headers` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { helmet } from "@minostack/mino/helmet";
 *
 * const app = new Mino();
 * app.use(helmet());
 * ```
 *
 * Set headers are only applied when the handler did not set them already —
 * explicit route headers always win. Any option set to `false` disables it.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";

export interface HelmetOptions {
  /** `X-Content-Type-Options: nosniff` (default true). */
  contentTypeOptions?: boolean;
  /** `X-Frame-Options` (default `"SAMEORIGIN"`). */
  frameGuard?: false | "DENY" | "SAMEORIGIN";
  /** `Referrer-Policy` (default `"no-referrer"`). */
  referrerPolicy?: false | string;
  /** `X-DNS-Prefetch-Control: off` (default true). */
  dnsPrefetchControl?: boolean;
  /**
   * `Strict-Transport-Security` — only sent on `https:` responses, never on
   * plain http (sending it there is a spec violation). Default true with
   * `maxAge` 15552000s (180 days), `includeSubDomains` on.
   */
  hsts?: false | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  /** `Content-Security-Policy` value (default false — opt-in, a wrong default breaks apps). */
  contentSecurityPolicy?: false | string;
}

/** Set a header only when the handler did not set one already. */
function setIfAbsent(h: Headers, name: string, value: string): void {
  if (!h.has(name)) h.set(name, value);
}

export function helmet(opts: HelmetOptions = {}): Handler {
  const contentTypeOptions = opts.contentTypeOptions ?? true;
  const frameGuard = opts.frameGuard ?? "SAMEORIGIN";
  const referrerPolicy = opts.referrerPolicy ?? "no-referrer";
  const dnsPrefetchControl = opts.dnsPrefetchControl ?? true;
  const hsts = opts.hsts ?? true;
  const csp = opts.contentSecurityPolicy ?? false;

  return async (c, next) => {
    await next();
    const res = c.res;
    if (!res) return;
    // Rebuild is required: Fetch Response headers are immutable.
    const h = new Headers(res.headers);
    if (contentTypeOptions) setIfAbsent(h, "x-content-type-options", "nosniff");
    if (frameGuard !== false) setIfAbsent(h, "x-frame-options", frameGuard);
    if (referrerPolicy !== false) setIfAbsent(h, "referrer-policy", referrerPolicy);
    if (dnsPrefetchControl) setIfAbsent(h, "x-dns-prefetch-control", "off");
    if (csp !== false) setIfAbsent(h, "content-security-policy", csp);
    if (hsts !== false) {
      // c.url triggers the lazy parse only when this middleware is installed.
      let isHttps = false;
      try {
        isHttps = c.url.protocol === "https:";
      } catch {
        isHttps = false;
      }
      if (isHttps) {
        const maxAge = hsts === true ? 15552000 : (hsts.maxAge ?? 15552000);
        const sub = hsts === true || (hsts.includeSubDomains ?? true) ? "; includeSubDomains" : "";
        const pre = hsts !== true && hsts.preload ? "; preload" : "";
        setIfAbsent(h, "strict-transport-security", `max-age=${maxAge}${sub}${pre}`);
      }
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
