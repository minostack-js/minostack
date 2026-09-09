/**
 * `@minostack/mino/basic-auth` — HTTP Basic authentication middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Headers`/`Response` + `atob` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { basic, safeEqualBasic } from "@minostack/mino/basic-auth";
 *
 * const app = new Mino();
 * app.use(
 *   basic({
 *     realm: "Acme",
 *     verify: (user, pass) =>
 *       safeEqualBasic(user, "admin") && safeEqualBasic(pass, "s3cret"),
 *   }),
 * );
 * app.get("/me", (c) => c.json({ user: (c.get("basicUser") as { name: string }).name }));
 * ```
 *
 * Behavior: parses `Authorization: Basic <base64>` (scheme match is
 * case-insensitive per RFC 7235), decodes, splits the `user:pass` pair on the
 * FIRST colon, and calls `verify(user, pass)` (sync or async). Failures answer
 * `401` JSON (`{ error, status, code }`) with
 * `WWW-Authenticate: Basic realm="..."` and never reach handlers.
 * Credentials are never logged.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";

/** State key the verified user is stored under (`c.get("basicUser")` → `{ name }`). */
export const BASIC_USER_KEY = "basicUser";

export interface BasicAuthOptions {
  /** Check credentials. Return `true` to admit, `false` to 401. Never log its inputs. */
  verify: (user: string, pass: string) => boolean | Promise<boolean>;
  /** Challenge realm (default `"Secure Area"`). */
  realm?: string;
}

/**
 * Constant-time string compare. Lengths leak (unavoidable without padding);
 * contents do not (no early exit on first mismatch). Compare the password
 * (never the secret itself in logs) inside `verify`.
 */
export function safeEqualBasic(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Base64 → UTF-8 (`atob` only, no Buffer — throws on garbage). */
function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function basic(opts: BasicAuthOptions): Handler {
  const realm = opts.realm ?? "Secure Area";
  const challenge = `Basic realm="${realm}"`;

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
    let b64: string | undefined;
    if (h) {
      // `<scheme> <credentials>` split — scheme match is case-insensitive per RFC 7235.
      const bits = h.trim().split(/\s+/);
      if (bits.length === 2 && /^basic$/i.test(bits[0] as string)) {
        b64 = bits[1] as string;
      }
    }
    if (!b64) return deny(c);
    let decoded: string;
    try {
      decoded = base64ToUtf8(b64);
    } catch {
      return deny(c);
    }
    const idx = decoded.indexOf(":");
    if (idx === -1) return deny(c);
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    let ok = false;
    try {
      ok = await opts.verify(user, pass);
    } catch {
      return deny(c);
    }
    if (!ok) return deny(c);
    // NOTE: store the name only — the password never touches context state.
    c.set(BASIC_USER_KEY, { name: user });
    await next();
    return;
  };
}
