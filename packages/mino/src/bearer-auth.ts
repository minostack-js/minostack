/**
 * `@minostack/mino/bearer-auth` — Bearer token authentication middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Headers`/`Response` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { bearer } from "@minostack/mino/bearer-auth";
 *
 * const app = new Mino();
 * // Static allow-list…
 * app.use(bearer({ tokens: ["s3cret-token"] }));
 * // …or a callback (sync or async). Return an object to stash a payload.
 * app.use(bearer({ verify: async (token) => lookupSession(token) }));
 * app.get("/me", (c) => c.json({ token: c.get("bearer") }));
 * ```
 *
 * Behavior: parses `Authorization: Bearer <token>` (scheme match is
 * case-insensitive per RFC 7235). Static tokens compare in constant time;
 * `verify` results admit on `true`/object and 401 on falsy. Failures answer
 * `401` JSON (`{ error, status, code }`) with a `WWW-Authenticate: Bearer`
 * challenge and never reach handlers. Tokens are never logged.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";

/** State key the admitted token is stored under (`c.get("bearer")`). */
export const BEARER_KEY = "bearer";
/** State key a `verify` object result is stored under (`c.get("bearerPayload")`). */
export const BEARER_PAYLOAD_KEY = "bearerPayload";

/** Admit on `true`/payload-object, reject on falsy. */
export type BearerVerifyResult = boolean | Record<string, unknown>;

export interface BearerAuthOptions {
  /** Static allow-list of tokens (constant-time compare). */
  tokens?: string[];
  /** Dynamic check (sync or async). An object result is stashed as the payload. */
  verify?: (token: string) => BearerVerifyResult | Promise<BearerVerifyResult>;
  /** Challenge realm — appended as `Bearer realm="..."` when set. */
  realm?: string;
}

/**
 * Constant-time string compare (local impl). Lengths leak (unavoidable
 * without padding); contents do not (no early exit on first mismatch).
 */
function safeEqualToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function bearer(opts: BearerAuthOptions): Handler {
  if (!opts.tokens && !opts.verify) {
    throw new Error("bearer middleware requires tokens or verify");
  }
  const challenge = opts.realm !== undefined ? `Bearer realm="${opts.realm}"` : "Bearer";

  const deny = (c: Context): Response => {
    const res = new Response(
      JSON.stringify({ error: "Unauthorized", status: 401, code: "unauthorized" }),
      {
        status: 401,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "www-authenticate": challenge,
        },
      },
    );
    c.setResponse(res);
    return res;
  };

  return async (c, next) => {
    const h = c.header("authorization");
    let token: string | undefined;
    if (h) {
      // `<scheme> <token>` split — scheme match is case-insensitive per RFC 7235.
      const bits = h.trim().split(/\s+/);
      if (bits.length === 2 && /^bearer$/i.test(bits[0] as string)) {
        token = bits[1] as string;
      }
    }
    if (!token) return deny(c);

    if (opts.tokens !== undefined) {
      let ok = false;
      for (const t of opts.tokens) {
        if (safeEqualToken(token, t)) ok = true;
      }
      if (!ok) return deny(c);
      c.set(BEARER_KEY, token);
      await next();
      return;
    }

    const verify = opts.verify as (
      token: string,
    ) => BearerVerifyResult | Promise<BearerVerifyResult>;
    let result: BearerVerifyResult;
    try {
      result = await verify(token);
    } catch {
      return deny(c);
    }
    if (typeof result === "object" && result !== null) {
      c.set(BEARER_KEY, token);
      c.set(BEARER_PAYLOAD_KEY, result);
    } else if (result) {
      c.set(BEARER_KEY, token);
    } else {
      return deny(c);
    }
    await next();
    return;
  };
}
