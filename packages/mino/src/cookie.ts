/**
 * `@minostack/mino/cookie` — cookie parsing, serialization and signed cookies.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Headers` + WebCrypto Subtle only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { getCookie, setCookie } from "@minostack/mino/cookie";
 *
 * const app = new Mino();
 * app.get("/", (c) => {
 *   const theme = getCookie(c, "theme") ?? "light";
 *   setCookie(c, "theme", theme, { path: "/", httpOnly: true, sameSite: "Lax" });
 *   return c.text(`theme=${theme}`);
 * });
 * ```
 *
 * Signing uses HMAC-SHA256 via SubtleCrypto. Signed values have the shape
 * `value.signature` where `signature` is base64url-encoded. Verification uses
 * `subtle.verify` (constant-time compare) — never string equality.
 */

import { BadRequestError } from "./errors.js";
import type { Context } from "./context.js";

/** Max cookies parsed from one `Cookie` header (DoS bound, mirrors validator). */
export const MAX_COOKIES = 100;
/** Max chars per cookie value (DoS bound, mirrors validator header limits). */
export const MAX_COOKIE_VALUE_CHARS = 8192;

/**
 * Parse a `Cookie` header into a name/value map. Splits on `;`, trims, splits
 * each pair on the first `=`, and `decodeURIComponent`s both sides (falling
 * back to the raw text when decoding fails). Throws `BadRequestError` past
 * the cookie-count or per-value caps. Never throws on malformed pairs —
 * segments without a name are skipped.
 */
export function parseCookie(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  let count = 0;
  for (const part of header.split(";")) {
    const raw = part.trim();
    if (!raw) continue;
    count++;
    if (count > MAX_COOKIES) {
      throw new BadRequestError("Too many cookies");
    }
    const eq = raw.indexOf("=");
    const nameRaw = (eq === -1 ? raw : raw.slice(0, eq)).trim();
    const valueRaw = eq === -1 ? "" : raw.slice(eq + 1).trim();
    if (!nameRaw) continue;
    if (valueRaw.length > MAX_COOKIE_VALUE_CHARS) {
      throw new BadRequestError("Cookie value too long");
    }
    out[decodeSafe(nameRaw)] = decodeSafe(stripQuotes(valueRaw));
  }
  return out;
}

/**
 * True when `s` contains a CTL (<=0x1F, 0x7F) or `;` — header-injection
 * vectors that must never appear in cookie names/attribute values.
 * Written as char-code scan (not a control-char regex) on purpose.
 */
function hasInvalidCookieChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code === 0x3b) return true;
  }
  return false;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

export interface CookieOptions {
  /** `Path` attribute (e.g. `"/"`). */
  path?: string;
  /** `Domain` attribute (e.g. `"example.com"`). */
  domain?: string;
  /** `Max-Age` in seconds (non-negative integer). */
  maxAge?: number;
  /** `Expires` timestamp. */
  expires?: Date;
  /** Emit `HttpOnly`. */
  httpOnly?: boolean;
  /** Emit `Secure`. Implied by `partitioned`. */
  secure?: boolean;
  /** `SameSite` policy. */
  sameSite?: "Strict" | "Lax" | "None";
  /** Emit `Partitioned` (CHIPS). Implies `Secure`. */
  partitioned?: boolean;
}

/**
 * Serialize a `Set-Cookie` value. Name and value are `encodeURIComponent`ed
 * so round-trips through {@link parseCookie} are exact. Rejects empty names
 * and names containing CTLs or `;` (header-injection vectors) with
 * `BadRequestError`. Attribute values containing `;`/CRLF are rejected too.
 */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  if (!name || hasInvalidCookieChars(name)) {
    throw new BadRequestError("Invalid cookie name");
  }
  let out = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (opts.domain !== undefined) {
    assertAttr("Domain", opts.domain);
    out += `; Domain=${opts.domain}`;
  }
  if (opts.path !== undefined) {
    assertAttr("Path", opts.path);
    out += `; Path=${opts.path}`;
  }
  if (opts.maxAge !== undefined) {
    if (!Number.isInteger(opts.maxAge) || opts.maxAge < 0) {
      throw new BadRequestError("Invalid Max-Age");
    }
    out += `; Max-Age=${opts.maxAge}`;
  }
  if (opts.expires !== undefined) {
    if (!(opts.expires instanceof Date) || Number.isNaN(opts.expires.getTime())) {
      throw new BadRequestError("Invalid Expires");
    }
    out += `; Expires=${opts.expires.toUTCString()}`;
  }
  if (opts.sameSite !== undefined) {
    if (opts.sameSite !== "Strict" && opts.sameSite !== "Lax" && opts.sameSite !== "None") {
      throw new BadRequestError("Invalid SameSite");
    }
    out += `; SameSite=${opts.sameSite}`;
  }
  // Partitioned cookies are rejected by browsers without Secure — imply it.
  if (opts.secure || opts.partitioned) out += "; Secure";
  if (opts.httpOnly) out += "; HttpOnly";
  if (opts.partitioned) out += "; Partitioned";
  return out;
}

function assertAttr(attr: string, value: string): void {
  if (!value || hasInvalidCookieChars(value)) {
    throw new BadRequestError(`Invalid cookie ${attr}`);
  }
}

/**
 * Minimal context surface cookies need — accepts any `Context<E, P>`
 * (the full `Context` is generic-invariant, this structural view is not).
 */
export interface CookieContext {
  /** Read a request header (case-insensitive). */
  header(name: string): string | undefined;
  /** Response currently set on the context, if any. */
  readonly res: Response | undefined;
  /** Store the response on the context. */
  setResponse(res: Response): void;
}

/**
 * Read one request cookie. Returns `undefined` when the `Cookie` header or
 * the named cookie is absent.
 */
export function getCookie(c: CookieContext, name: string): string | undefined {
  const header = c.header("cookie");
  if (!header) return undefined;
  return parseCookie(header)[name];
}

/**
 * Append a `Set-Cookie` entry without clobbering existing ones. Fetch
 * `Headers.append("set-cookie", …)` keeps entries separate (never comma-joined),
 * so this works on every runtime; read them back with {@link getSetCookies}.
 */
export function appendSetCookie(headers: Headers, value: string): void {
  headers.append("set-cookie", value);
}

/**
 * Read back the individual `Set-Cookie` values of a `Headers` object.
 * Uses `getSetCookie()` where available, otherwise falls back to a single
 * `get()` (naive: `Expires` commas make exact splitting impossible there,
 * so prefer runtimes with `getSetCookie` when asserting multiples).
 */
export function getSetCookies(headers: Headers): string[] {
  const withMethod = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withMethod.getSetCookie === "function") {
    return withMethod.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single === null ? [] : [single];
}

// Pending cookies queued before the handler produced a response. Flushed by
// patching this request's context (response factories + setResponse), so both
// `return c.text(…)` and `return new Response(…)` carry them. Keyed by context
// — never shared across requests.
const pending = new WeakMap<object, string[]>();
const patched = new WeakSet<object>();
const FACTORY_METHODS = ["json", "text", "html", "redirect", "body", "sse"] as const;

function flushInto(c: CookieContext, res: Response): Response {
  const arr = pending.get(c);
  if (!arr || arr.length === 0) return res;
  try {
    for (const v of arr) res.headers.append("set-cookie", v);
    arr.length = 0;
    return res;
  } catch {
    // Immutable headers (e.g. adapter-supplied) — rebuild instead.
    const h = new Headers(res.headers);
    for (const v of arr) h.append("set-cookie", v);
    arr.length = 0;
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: h,
    });
  }
}

function ensurePatched(c: CookieContext): void {
  if (patched.has(c)) return;
  patched.add(c);
  const rec = c as unknown as Record<string, unknown>;
  for (const m of FACTORY_METHODS) {
    const orig = rec[m];
    if (typeof orig !== "function") continue;
    const fn = orig as (...args: unknown[]) => unknown;
    rec[m] = (...args: unknown[]): unknown => {
      const out = fn.apply(c, args);
      if (out instanceof Response) return flushInto(c, out);
      return out;
    };
  }
  const origSR = rec["setResponse"];
  if (typeof origSR === "function") {
    const fn = origSR as (res: Response) => void;
    rec["setResponse"] = (res: Response): void => {
      fn.call(c, flushInto(c, res));
    };
  }
}

/**
 * Queue (or, when a response already exists, immediately append) a
 * `Set-Cookie`. Never overwrites previously set cookies. Returns the
 * serialized value. Safe to call before the handler returns — queued values
 * are attached to whatever response the handler produces.
 */
export function setCookie(
  c: CookieContext,
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  const serialized = serializeCookie(name, value, opts);
  const res = c.res;
  if (res) {
    // Response already set (e.g. middleware after `next()`) — rebuild per the
    // strict middleware contract: `new Response(body, {status, statusText, headers})`.
    // (Anything queued earlier was already flushed when the response was created.)
    const h = new Headers(res.headers);
    h.append("set-cookie", serialized);
    const out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: h,
    });
    c.setResponse(out);
    return serialized;
  }
  let arr = pending.get(c);
  if (!arr) {
    arr = [];
    pending.set(c, arr);
  }
  arr.push(serialized);
  ensurePatched(c);
  return serialized;
}

// ─────────────────────────────────────────────────────────────────
// Signed cookies (HMAC-SHA256 via SubtleCrypto)
// ─────────────────────────────────────────────────────────────────

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

/** UTF-8 bytes as a concrete `Uint8Array<ArrayBuffer>` (satisfies BufferSource typing). */
function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(s));
}

/** Base64url-encode bytes (local helper, no Buffer — runtime-agnostic). */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url-decode to bytes (local helper, no Buffer — throws on garbage). */
function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9\-_]*$/.test(s)) throw new Error("Invalid base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string | Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  const raw: Uint8Array<ArrayBuffer> =
    typeof secret === "string" ? utf8(secret) : new Uint8Array(secret);
  return subtle().importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/**
 * Sign a cookie value: `value.base64url(HMAC-SHA256(value))`. The raw value
 * stays readable (signing is integrity, not encryption) — never put secrets
 * in here, and never log the secret.
 */
export async function signCookie(value: string, secret: string | Uint8Array): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const sig = await subtle().sign({ name: "HMAC" }, key, utf8(value));
  return `${value}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

/**
 * Verify a signed cookie. Returns the original value, or `null` when the
 * signature is missing/malformed, the value was tampered with, or the secret
 * does not match. Splits on the LAST `.` so values containing dots survive.
 */
export async function unsignCookie(
  signed: string,
  secret: string | Uint8Array,
): Promise<string | null> {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const sigB64 = signed.slice(dot + 1);
  if (!sigB64) return null;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64UrlToBytes(sigB64);
  } catch {
    return null;
  }
  try {
    const key = await hmacKey(secret, "verify");
    const ok = await subtle().verify({ name: "HMAC" }, key, sig, utf8(value));
    return ok ? value : null;
  } catch {
    return null;
  }
}

/** Bound signer for one secret — handy for app-wide cookie signing. */
export function createCookieSigner(secret: string | Uint8Array): {
  sign: (value: string) => Promise<string>;
  unsign: (signed: string) => Promise<string | null>;
} {
  return {
    sign: (value) => signCookie(value, secret),
    unsign: (signed) => unsignCookie(signed, secret),
  };
}

// Re-export the base `Context` type for convenience.
export type { Context };
