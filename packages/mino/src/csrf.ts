/**
 * `@minostack/mino/csrf` — Cross-Site Request Forgery protection middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Headers`/`Response` only —
 * token randomness via `crypto.randomUUID()` with a `Math.random` fallback,
 * same as `request-id.ts`).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { csrf, csrfWithStore } from "@minostack/mino/csrf";
 *
 * const app = new Mino();
 * // Double-submit cookie (stateless): cookie value must equal the header.
 * app.use(csrf());
 *
 * // Synchronizer mode (stateful): tokens are allow-listed server-side.
 * app.use(csrfWithStore({ store }));
 * ```
 *
 * Behavior: safe methods (`GET`/`HEAD`/`OPTIONS` by default) ensure a token
 * cookie exists (issuing one when absent) and then call downstream. Unsafe
 * methods compare the `x-csrf-token` header against the cookie with a
 * constant-time compare and additionally reject requests whose
 * `Origin`/`Referer` host mismatches the request host. Failures answer
 * `403` JSON (`{ error, status, code }`) and never reach handlers.
 * Tokens and secrets are never logged.
 */

import type { Context } from "./context.js";
import type { Store } from "./session.js";
import type { Handler } from "./types.js";

export interface CsrfOptions {
  /** Token cookie name (default `"csrf-token"`). */
  cookieName?: string;
  /** Header the client echoes the token in (default `"x-csrf-token"`). */
  headerName?: string;
  /** Methods that only ensure a cookie exists (default `GET,HEAD,OPTIONS`). */
  ignoreMethods?: string[];
  /** Token length in chars (default `32`). */
  tokenLength?: number;
}

export interface CsrfWithStoreOptions extends CsrfOptions {
  /** Server-side token allow-list (`@minostack/mino/session` `Store`). */
  store: Store;
}

/**
 * Constant-time string compare. Lengths leak (unavoidable without padding);
 * contents do not (no early exit on first mismatch).
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Random token (`crypto.randomUUID()` hex, `getRandomValues`/`Math.random` fallback). */
export function generateCsrfToken(tokenLength = 32): string {
  const len = Math.max(1, Math.floor(tokenLength));
  try {
    const c = (
      globalThis as {
        crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array };
      }
    ).crypto;
    if (c && typeof c.randomUUID === "function") {
      let hex = "";
      while (hex.length < len) hex += c.randomUUID().replace(/-/g, "");
      return hex.slice(0, len);
    }
    if (c && typeof c.getRandomValues === "function") {
      const bytes = new Uint8Array(Math.ceil(len / 2));
      c.getRandomValues(bytes);
      return Array.from(bytes, (x) => x.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, len);
    }
  } catch {
    // fall through to Math.random fallback (non-secure contexts)
  }
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  while (s.length < len) s += chars[Math.floor(Math.random() * chars.length)] ?? "x";
  return s;
}

function readCookie(c: Context, name: string): string | undefined {
  const header = c.header("cookie");
  if (!header) return undefined;
  const parts = header.split(";");
  for (let part of parts) {
    part = part.trim();
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    let v = part.slice(idx + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return undefined;
}

function isHttps(c: Context): boolean {
  try {
    return c.url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The CSRF cookie must be JS-readable (the client echoes it in a header),
 * so it is deliberately NOT `HttpOnly`. Scoped to `Path=/`, `SameSite=Lax`.
 */
function serializeTokenCookie(name: string, token: string, secure: boolean): string {
  let s = `${name}=${encodeURIComponent(token)}; Path=/; SameSite=Lax`;
  if (secure) s += "; Secure";
  return s;
}

function responseSetsCookie(res: Response, name: string): boolean {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const list =
    typeof h.getSetCookie === "function"
      ? h.getSetCookie()
      : (() => {
          const v = h.get("set-cookie");
          return v ? [v] : [];
        })();
  return list.some((s) => {
    // split() always yields ≥1 element; the cast keeps noUncheckedIndexedAccess honest.
    const first = (s.split(";")[0] as string).trim();
    return first === `${name}=` || first.startsWith(`${name}=`);
  });
}

function requestHost(c: Context): string | undefined {
  const host = c.header("host");
  if (host) return host.toLowerCase();
  try {
    return c.url.host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * True when `Origin` (preferred) or `Referer` is present and its host
 * differs from the request host. Absent headers → false (the token compare
 * remains the primary defense, e.g. for non-browser clients).
 */
function isCrossOrigin(c: Context): boolean {
  const check = c.header("origin") ?? c.header("referer") ?? c.header("referrer");
  if (!check) return false;
  let checkHost: string;
  try {
    checkHost = new URL(check).host.toLowerCase();
  } catch {
    return true;
  }
  const host = requestHost(c);
  if (!host) return false;
  return checkHost !== host;
}

function forbidden(message: string): Response {
  return new Response(JSON.stringify({ error: message, status: 403, code: "csrf_failed" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function ignoreSet(methods: string[] | undefined): Set<string> {
  return new Set((methods ?? ["GET", "HEAD", "OPTIONS"]).map((m) => m.toUpperCase()));
}

/** Append the token cookie to the downstream response (rebuild required). */
function attachTokenCookie(
  ctx: Context,
  res: Response,
  cookieName: string,
  token: string,
): Response {
  const h = new Headers(res.headers);
  if (!responseSetsCookie(res, cookieName)) {
    h.append("set-cookie", serializeTokenCookie(cookieName, token, isHttps(ctx)));
  }
  // NOTE: return (not just setResponse) — compose() prefers nextResult.
  const out = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h,
  });
  ctx.setResponse(out);
  return out;
}

export function csrf(opts: CsrfOptions = {}): Handler {
  const cookieName = opts.cookieName ?? "csrf-token";
  const headerName = opts.headerName ?? "x-csrf-token";
  const ignore = ignoreSet(opts.ignoreMethods);
  const tokenLength = opts.tokenLength ?? 32;

  return async (c, next) => {
    const ctx = c as unknown as Context;
    if (ignore.has(ctx.method.toUpperCase())) {
      if (readCookie(ctx, cookieName)) {
        await next();
        return;
      }
      const token = generateCsrfToken(tokenLength);
      await next();
      if (ctx.res) return attachTokenCookie(ctx, ctx.res, cookieName, token);
      return;
    }

    if (isCrossOrigin(ctx)) {
      const res = forbidden("Cross-origin request rejected");
      ctx.setResponse(res);
      return res;
    }
    const cookie = readCookie(ctx, cookieName);
    const header = ctx.header(headerName);
    if (!cookie || !header || !safeEqual(header, cookie)) {
      const res = forbidden("Invalid CSRF token");
      ctx.setResponse(res);
      return res;
    }
    await next();
  };
}

/**
 * Synchronizer-token mode: issued tokens are allow-listed in `store`
 * (`{ token }` records keyed by the token itself, so the client flow is
 * identical to double-submit). Unsafe requests must present a
 * cookie+header pair that is both self-consistent AND present server-side —
 * a forged self-consistent pair is rejected. Stale store entries should be
 * bounded by the store's own TTL/cap policy (e.g. `MemoryStore` cap).
 */
export function csrfWithStore(opts: CsrfWithStoreOptions): Handler {
  const store = opts.store;
  if (!store) throw new Error("csrfWithStore() requires a store");
  const cookieName = opts.cookieName ?? "csrf-token";
  const headerName = opts.headerName ?? "x-csrf-token";
  const ignore = ignoreSet(opts.ignoreMethods);
  const tokenLength = opts.tokenLength ?? 32;

  return async (c, next) => {
    const ctx = c as unknown as Context;
    if (ignore.has(ctx.method.toUpperCase())) {
      const existing = readCookie(ctx, cookieName);
      if (existing) {
        let live = false;
        try {
          live = (await store.get(existing)) !== undefined;
        } catch {
          live = false;
        }
        if (live) {
          await next();
          return;
        }
        // Known cookie but no server record (expired/evicted) → rotate below.
      }
      const token = generateCsrfToken(tokenLength);
      // Fail closed: without a stored record the token can never validate.
      await store.set(token, { token });
      await next();
      if (ctx.res) return attachTokenCookie(ctx, ctx.res, cookieName, token);
      return;
    }

    if (isCrossOrigin(ctx)) {
      const res = forbidden("Cross-origin request rejected");
      ctx.setResponse(res);
      return res;
    }
    const cookie = readCookie(ctx, cookieName);
    const header = ctx.header(headerName);
    if (!cookie || !header || !safeEqual(header, cookie)) {
      const res = forbidden("Invalid CSRF token");
      ctx.setResponse(res);
      return res;
    }
    let expected: string | undefined;
    try {
      const rec = await store.get(cookie);
      const t = rec?.["token"];
      expected = typeof t === "string" ? t : undefined;
    } catch {
      expected = undefined;
    }
    if (!expected || !safeEqual(header, expected)) {
      const res = forbidden("Invalid CSRF token");
      ctx.setResponse(res);
      return res;
    }
    await next();
  };
}
