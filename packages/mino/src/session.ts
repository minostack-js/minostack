/**
 * `@minostack/mino/session` — cookie-backed signed session middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Headers`/`Response` +
 * WebCrypto `SubtleCrypto` only — no `node:*`, no `Buffer`).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { session, MemoryStore } from "@minostack/mino/session";
 *
 * const app = new Mino();
 * // Stateless (whole session lives in the signed cookie, 4kb cap):
 * app.use(session({ secret: "replace-me-with-32+-random-chars" }));
 * // Server-side (only `sid` + expiry in the cookie, data in the store):
 * app.use(session({ secret: "...", store: new MemoryStore() }));
 *
 * app.post("/login", (c) => {
 *   (c.get("session") as Record<string, unknown>).user = "ada";
 *   return c.json({ ok: true });
 * });
 * ```
 *
 * Contract: the middleware attaches a plain-object session to
 * `c.set("session", data)` plus `c.set("sessionId", sid)`. Mutate the object
 * (or replace it via `c.set("session", next)`) and the middleware re-signs
 * and appends `Set-Cookie` after `next()`. Setting the session to `null` /
 * `undefined` destroys it (store entry removed, cookie cleared). Read-only
 * requests never get a `Set-Cookie`. Tampered/expired cookies are discarded
 * silently and start a fresh session — attacker bytes never reach handlers.
 * Secrets and session contents are never logged.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";
import { InvalidTokenError } from "./errors.js";

/** State keys used on `Context.state`. */
export const SESSION_KEY = "session";
export const SESSION_ID_KEY = "sessionId";

/**
 * Server-side session storage. All methods may be sync or async.
 * `ttlMs` is a hint (sliding or absolute is the store's choice); stores
 * without TTL support may ignore it.
 */
export interface Store {
  get(
    id: string,
  ): Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  set(id: string, data: Record<string, unknown>, ttlMs?: number): Promise<void> | void;
  destroy(id: string): Promise<void> | void;
}

/**
 * Single-process in-memory `Store` with TTL expiry and an oldest-evict cap.
 * Expired entries are pruned on `set`; when full, the oldest inserted key is
 * evicted. For multi-instance deployments use a shared external store.
 */
export class MemoryStore implements Store {
  private entries = new Map<string, { data: Record<string, unknown>; exp?: number }>();
  private readonly cap: number;

  constructor(maxEntries = 10000) {
    this.cap = Math.max(1, Math.floor(maxEntries));
  }

  /** Current live-entry count (expired entries are pruned lazily). */
  get size(): number {
    return this.entries.size;
  }

  get(id: string): Record<string, unknown> | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    if (e.exp !== undefined && e.exp <= Date.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return { ...e.data };
  }

  set(id: string, data: Record<string, unknown>, ttlMs?: number): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.exp !== undefined && v.exp <= now) this.entries.delete(k);
    }
    if (!this.entries.has(id) && this.entries.size >= this.cap) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(id, {
      data: { ...data },
      exp: ttlMs === undefined ? undefined : now + ttlMs,
    });
  }

  destroy(id: string): void {
    this.entries.delete(id);
  }
}

export interface SessionOptions {
  /** HMAC-SHA256 signing secret (required, non-empty — never logged). */
  secret: string;
  /** Session cookie name (default `"mino-session"`). */
  cookieName?: string;
  /** Server-side store. Omit for stateless (whole session in the cookie). */
  store?: Store;
  /** Session lifetime in seconds (default `86400` = 24h). */
  maxAgeSec?: number;
}

/** Random session id (`crypto.randomUUID()` with `Math.random` fallback). */
export function generateSessionId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    // fall through to Math.random fallback (non-secure contexts)
  }
  const hex = (): string =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(1, 4)}-${hex().slice(0, 4)}-${hex()}${hex().slice(0, 4)}`;
}

/**
 * Rotate the session id (fixation defense — call after privilege changes
 * such as login). The middleware persists data under the new id and destroys
 * the previous server-side entry after `next()` settles.
 */
export function regenerateSessionId(c: Context): string {
  const id = generateSessionId();
  c.set(SESSION_ID_KEY, id);
  return id;
}

// ─────────────────────────────────────────────────────────────────
// Refresh-token rotation with reuse detection (plan P1.3).
// The store holds one live refresh id per chain; presenting a superseded
// id signals theft and destroys the whole chain.
// ─────────────────────────────────────────────────────────────────

export interface RotationRecord {
  /** Current live refresh id for this chain */
  current: string;
  /** Superseded ids still within their grace window (already rejected) */
  retired: string[];
}

/**
 * Rotating refresh-token store. `rotate(chainId)` mints the next id and
 * retires the previous one; `consume(chainId, presented)` returns the live
 * id when `presented` is current, throws `InvalidTokenError` when the chain
 * is unknown, and destroys the chain + throws on reuse of a retired id.
 */
export class RotatingTokenStore {
  private chains = new Map<string, RotationRecord>();

  /** Start a chain (e.g. at login). Returns the first refresh id. */
  begin(chainId: string): string {
    const id = generateSessionId();
    this.chains.set(chainId, { current: id, retired: [] });
    return id;
  }

  /** Mint the next refresh id; the previous id becomes retired (rejected). */
  rotate(chainId: string): string {
    const rec = this.chains.get(chainId);
    if (!rec) throw new InvalidTokenError("Unknown refresh chain");
    const next = generateSessionId();
    rec.retired.push(rec.current);
    // Bound the retired list — chains are long-lived, memory is not infinite.
    if (rec.retired.length > 16) rec.retired.splice(0, rec.retired.length - 16);
    rec.current = next;
    return next;
  }

  /**
   * Validate a presented refresh id. Returns the live id to continue with.
   * Reuse of a retired id destroys the chain (theft response).
   */
  consume(chainId: string, presented: string): string {
    const rec = this.chains.get(chainId);
    if (!rec) throw new InvalidTokenError("Unknown refresh chain");
    if (presented === rec.current) return rec.current;
    if (rec.retired.includes(presented)) {
      this.chains.delete(chainId);
      throw new InvalidTokenError("Refresh token reuse detected");
    }
    throw new InvalidTokenError("Unknown refresh token");
  }

  /** Revoke a chain outright (e.g. logout everywhere). */
  revoke(chainId: string): void {
    this.chains.delete(chainId);
  }

  /** Chain count (dev/test introspection). */
  get size(): number {
    return this.chains.size;
  }
}

// ─────────────────────────────────────────────────────────────────
// Cookie helpers (local — `cookie.ts` does not exist in this package)
// ─────────────────────────────────────────────────────────────────

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

function serializeCookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  if (secure) s += "; Secure";
  return s;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

// ─────────────────────────────────────────────────────────────────
// HMAC-SHA256 signing (WebCrypto only)
// ─────────────────────────────────────────────────────────────────

interface SessionPayload {
  sid: string;
  data: Record<string, unknown>;
  exp: number;
}

function getSubtle(): SubtleCrypto {
  const g = globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } };
  const subtle = g.crypto?.subtle;
  if (!subtle) throw new Error("session() requires WebCrypto SubtleCrypto");
  return subtle;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  else if (pad !== 0) throw new Error("bad encoding");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return getSubtle().importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: SessionPayload, secret: string): Promise<string> {
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const sig = await getSubtle().sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Returns the payload on valid signature + shape, else `undefined`. Never throws. */
async function unsign(token: string, secret: string): Promise<SessionPayload | undefined> {
  try {
    const dot = token.indexOf(".");
    if (dot === -1) return undefined;
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    if (!payloadB64 || !sigB64) return undefined;
    const key = await importHmacKey(secret);
    const sig = b64urlDecode(sigB64);
    const valid = await getSubtle().verify(
      "HMAC",
      key,
      sig as unknown as BufferSource,
      new TextEncoder().encode(payloadB64),
    );
    if (!valid) return undefined;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const o = parsed as Record<string, unknown>;
    if (typeof o["sid"] !== "string" || typeof o["exp"] !== "number") return undefined;
    const data = o["data"];
    if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) {
      return undefined;
    }
    return { sid: o["sid"], data: (data ?? {}) as Record<string, unknown>, exp: o["exp"] };
  } catch {
    return undefined;
  }
}

/** Stateless cookies must stay small — browsers truncate past ~4kb. */
const MAX_COOKIE_BYTES = 4096;

function jsonError(message: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: message, status, code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function session(opts: SessionOptions): Handler {
  const secret = opts.secret;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("session() requires a non-empty secret");
  }
  const cookieName = opts.cookieName ?? "mino-session";
  const store = opts.store;
  const maxAgeSec = opts.maxAgeSec ?? 86400;

  return async (c, next) => {
    const ctx = c as unknown as Context;
    const secure = isHttps(ctx);
    let sid: string | undefined;
    let data: Record<string, unknown> = {};

    const raw = readCookie(ctx, cookieName);
    if (raw) {
      const payload = await unsign(raw, secret);
      if (payload && payload.exp > Date.now()) {
        sid = payload.sid;
        if (store) {
          try {
            const server = await store.get(sid);
            if (server) data = { ...server };
            // Valid signature but no server record (evicted/expired) →
            // fresh data under the same sid; a write below re-persists it.
          } catch {
            data = {};
          }
        } else {
          data = { ...payload.data };
        }
      }
      // Expired/tampered → fall through with a fresh session. Attacker
      // bytes are discarded here and never reach handlers.
    }
    const initialSid = sid;
    if (!sid) sid = generateSessionId();
    const snapshot = JSON.stringify(data);

    ctx.set(SESSION_KEY, data);
    ctx.set(SESSION_ID_KEY, sid);
    await next();

    const current = ctx.get(SESSION_KEY) as Record<string, unknown> | null | undefined;
    const currentSid = (ctx.get(SESSION_ID_KEY) as string | undefined) ?? sid;

    // Destroy path: handler nulled the session.
    if (current === null || current === undefined) {
      if (store) {
        try {
          await store.destroy(currentSid);
          if (initialSid && initialSid !== currentSid) await store.destroy(initialSid);
        } catch {
          // Storage failure on destroy — cookie is still cleared below.
        }
      }
      if (ctx.res) {
        const h = new Headers(ctx.res.headers);
        h.append("set-cookie", clearCookie(cookieName));
        const out = new Response(ctx.res.body, {
          status: ctx.res.status,
          statusText: ctx.res.statusText,
          headers: h,
        });
        ctx.setResponse(out);
        return out;
      }
      return;
    }

    const mutated = JSON.stringify(current) !== snapshot;
    const rotated = currentSid !== sid;
    if (!mutated && !rotated) return;

    // Fixation cleanup: a rotated id orphans the previous server entry.
    if (store) {
      try {
        await store.set(currentSid, current, maxAgeSec * 1000);
        if (initialSid && initialSid !== currentSid) await store.destroy(initialSid);
      } catch {
        const res = jsonError("Session store unavailable", 500, "session_store_error");
        ctx.setResponse(res);
        return res;
      }
    }

    const exp = Date.now() + maxAgeSec * 1000;
    const token = await sign({ sid: currentSid, data: store ? {} : current, exp }, secret);

    if (!store && new TextEncoder().encode(token).length > MAX_COOKIE_BYTES) {
      const res = jsonError("Session Too Large", 400, "session_too_large");
      ctx.setResponse(res);
      return res;
    }

    if (ctx.res) {
      const h = new Headers(ctx.res.headers);
      h.append("set-cookie", serializeCookie(cookieName, token, maxAgeSec, secure));
      // NOTE: return (not just setResponse) — compose() prefers nextResult.
      const out = new Response(ctx.res.body, {
        status: ctx.res.status,
        statusText: ctx.res.statusText,
        headers: h,
      });
      ctx.setResponse(out);
      return out;
    }
    // No downstream response (404 path): server data is already persisted
    // above; without a response there is nowhere to attach the cookie.
  };
}
