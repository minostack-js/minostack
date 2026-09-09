/**
 * `@minostack/mino/formbody` — `application/x-www-form-urlencoded` body parser middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Request.clone()` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { formbody } from "@minostack/mino/formbody";
 * import { validator } from "@minostack/mino";
 *
 * const app = new Mino();
 * app.post("/submit", formbody(), validator("form", Schema), (c) => {
 *   return c.json(c.valid("form"));
 * });
 * ```
 *
 * For urlencoded requests the body is read bounded by `opts.limit ??
 * c.limits.form` (413 past the cap — `readLimitedText` throws
 * `PayloadTooLargeError`, surfaced by the error handler), pairs are split on
 * `&` (first `=` divides key from value, `+` decodes to space, malformed
 * escapes fall back to the raw segment, LAST value wins per key — documented
 * contract), the pair count is enforced against `c.limits.fieldCount` (413
 * past the cap), and the object is cached as both `"form"` and `"_rawForm"`
 * validated values so `validator("form", …)` reuses the bounded parse instead
 * of re-reading the body. Other content types pass straight through to
 * `next()`. Nothing is logged (form fields may carry PII — never log them).
 */

import { readLimitedText } from "./context.js";
import type { Context } from "./context.js";
import { PayloadTooLargeError } from "./errors.js";
import type { Handler } from "./types.js";

export interface FormbodyOptions {
  /** Max urlencoded body bytes (default `c.limits.form`). */
  limit?: number;
}

/** `+` → space, then percent-decode; malformed escapes keep the raw segment. */
function decodeField(segment: string): string {
  try {
    return decodeURIComponent(segment.replace(/\+/g, " "));
  } catch {
    return segment;
  }
}

export function formbody(opts: FormbodyOptions = {}): Handler {
  return async (c, next) => {
    const ctx = c as unknown as Context;
    const ct = ctx.header("content-type") ?? "";
    if (!ct.includes("application/x-www-form-urlencoded")) {
      await next();
      return;
    }
    const limit = opts.limit ?? ctx.limits.form;
    // readLimitedText enforces the byte cap (throws PayloadTooLargeError → 413).
    const text = await readLimitedText(ctx.req.clone(), limit);
    const obj: Record<string, string> = {};
    if (text.length > 0) {
      const pairs = text.split("&");
      if (pairs.length > ctx.limits.fieldCount) {
        throw new PayloadTooLargeError(`Form exceeds limit of ${ctx.limits.fieldCount} fields`);
      }
      for (const pair of pairs) {
        if (pair.length === 0) continue;
        const eq = pair.indexOf("=");
        const key = eq === -1 ? decodeField(pair) : decodeField(pair.slice(0, eq));
        const value = eq === -1 ? "" : decodeField(pair.slice(eq + 1));
        // LAST value wins per key (documented contract).
        obj[key] = value;
      }
    }
    ctx.setValidated("form", obj);
    ctx.setValidated("_rawForm", obj);
    await next();
  };
}
