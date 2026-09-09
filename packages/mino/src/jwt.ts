/**
 * `@minostack/mino/jwt` — JWT sign/verify (HS256, RS256, ES256) + auth middleware.
 *
 * Zero dependencies, runtime-agnostic (WebCrypto Subtle only — no `node:*`).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { jwt, sign } from "@minostack/mino/jwt";
 *
 * const app = new Mino();
 * app.use(jwt({ secret: "s3cret" }));
 * app.get("/me", (c) => c.json({ sub: (c.get("jwtPayload") as { sub: string }).sub }));
 *
 * const token = await sign({ sub: "u1" }, "s3cret", { expiresInSec: 3600 });
 * ```
 *
 * Key inputs: raw secret strings (HS256, UTF-8) / `Uint8Array`, `CryptoKey`,
 * or JWK objects. RS/ES accept `CryptoKey` or JWK. JWKS matching is by `kid`.
 * All verification failures throw `UnauthorizedError` (401) — never log
 * tokens or key material; error bodies stay `{error, status, code}` shaped.
 */

import { ForbiddenError, UnauthorizedError } from "./errors.js";
import type { Context } from "./context.js";
import type { Handler } from "./types.js";
import { parseCookie } from "./cookie.js";
import { paseto, PASETO_PAYLOAD_KEY, type PasetoMiddlewareOptions } from "./paseto.js";

// Re-exported so handlers can express verified-but-not-permitted cases
// (e.g. scope checks on the verified payload) without importing errors.js.
export { ForbiddenError };

export type JwtAlgorithm = "HS256" | "RS256" | "ES256";

/** JWS-protected header. Extra members are preserved but otherwise ignored. */
export interface JwtHeader {
  alg: JwtAlgorithm;
  typ?: string;
  kid?: string;
  [key: string]: unknown;
}

/** JWT claims set. Standard time claims are `exp`/`nbf`/`iat` (seconds). */
export type JwtPayload = Record<string, unknown>;

/** Accepted key material: raw secret (HS256), bytes, WebCrypto key, or JWK. */
export type JwtKey = string | Uint8Array | CryptoKey | JwtJwk;

/**
 * JSON Web Key subset jwt needs. Declared locally (instead of the global
 * `JsonWebKey`) so `kid`/`crv` are typed on every runtime lib.
 */
export type JwtJwk = Record<string, unknown> & {
  kty: string;
  kid?: string;
  crv?: string;
};

export interface JwtSignOptions {
  /** Signature algorithm (default `"HS256"`). */
  alg?: JwtAlgorithm;
  /** Seconds from now for the `exp` claim (also sets `iat` when absent). */
  expiresInSec?: number;
  /** Key ID to embed as `kid` (used for JWKS matching). */
  kid?: string;
}

export interface JwtVerifyOptions {
  /** Leeway in seconds for `exp`/`nbf`/`iat` (default `0`). */
  clockToleranceSec?: number;
  /** Required `iss` (string equality). */
  issuer?: string | string[];
  /** Required `aud` (string equality; either side may be an array). */
  audience?: string | string[];
  /** Allowed algorithms — rejects tokens whose `alg` is not listed. */
  algorithms?: JwtAlgorithm[];
}

export interface JwtDecoded {
  header: JwtHeader;
  payload: JwtPayload;
}

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

function isJwk(key: JwtKey): key is JwtJwk {
  return (
    typeof key === "object" &&
    key !== null &&
    !(key instanceof Uint8Array) &&
    "kty" in (key as Record<string, unknown>)
  );
}

function signParams(alg: JwtAlgorithm): AlgorithmIdentifier | EcdsaParams {
  if (alg === "HS256") return { name: "HMAC" };
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5" };
  return { name: "ECDSA", hash: "SHA-256" };
}

function importParams(
  alg: JwtAlgorithm,
): AlgorithmIdentifier | HmacImportParams | RsaHashedImportParams | EcKeyImportParams {
  if (alg === "HS256") return { name: "HMAC", hash: "SHA-256" };
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return { name: "ECDSA", namedCurve: "P-256" };
}

async function importKeyMaterial(
  alg: JwtAlgorithm,
  key: JwtKey,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  if (typeof key === "string" || key instanceof Uint8Array) {
    if (alg !== "HS256") {
      throw new Error(`${alg} requires a CryptoKey or JWK, not a raw secret`);
    }
    const raw: Uint8Array<ArrayBuffer> = typeof key === "string" ? utf8(key) : new Uint8Array(key);
    return subtle().importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
  }
  if (isJwk(key)) {
    if (alg === "ES256" && key.crv !== undefined && key.crv !== "P-256") {
      throw new Error(`ES256 requires a P-256 key, got crv=${String(key.crv)}`);
    }
    return subtle().importKey("jwk", key as unknown as JsonWebKey, importParams(alg), false, [
      usage,
    ]);
  }
  return key;
}

/**
 * Sign a payload. With `expiresInSec`, sets `exp = now + expiresInSec` and
 * defaults `iat` to now when absent. Payload must be a plain object.
 */
export async function sign(
  payload: JwtPayload,
  key: JwtKey,
  opts: JwtSignOptions = {},
): Promise<string> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("JWT payload must be an object");
  }
  const alg = opts.alg ?? "HS256";
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { ...payload };
  if (opts.expiresInSec !== undefined) {
    if (!Number.isFinite(opts.expiresInSec)) throw new Error("expiresInSec must be finite");
    body["exp"] = now + Math.floor(opts.expiresInSec);
    if (body["iat"] === undefined) body["iat"] = now;
  }
  const header: JwtHeader = {
    alg,
    typ: "JWT",
    ...(opts.kid !== undefined ? { kid: opts.kid } : {}),
  };
  const hB64 = bytesToBase64Url(utf8(JSON.stringify(header)));
  const pB64 = bytesToBase64Url(utf8(JSON.stringify(body)));
  const cryptoKey = await importKeyMaterial(alg, key, "sign");
  const sig = await subtle().sign(signParams(alg), cryptoKey, utf8(`${hB64}.${pB64}`));
  return `${hB64}.${pB64}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

function assertClaims(payload: JwtPayload, opts: JwtVerifyOptions): void {
  const now = Math.floor(Date.now() / 1000);
  const tol = opts.clockToleranceSec ?? 0;
  const exp = payload["exp"];
  if (exp !== undefined) {
    if (typeof exp !== "number" || !Number.isFinite(exp)) {
      throw new UnauthorizedError("Invalid exp claim");
    }
    if (now > exp + tol) throw new UnauthorizedError("Token expired");
  }
  const nbf = payload["nbf"];
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isFinite(nbf)) {
      throw new UnauthorizedError("Invalid nbf claim");
    }
    if (now + tol < nbf) throw new UnauthorizedError("Token not yet valid");
  }
  const iat = payload["iat"];
  if (iat !== undefined) {
    if (typeof iat !== "number" || !Number.isFinite(iat)) {
      throw new UnauthorizedError("Invalid iat claim");
    }
    if (iat > now + tol) throw new UnauthorizedError("Invalid iat claim");
  }
  if (opts.issuer !== undefined) {
    const expected = Array.isArray(opts.issuer) ? opts.issuer : [opts.issuer];
    const actual = payload["iss"];
    if (typeof actual !== "string" || !expected.includes(actual)) {
      throw new UnauthorizedError("Invalid issuer");
    }
  }
  if (opts.audience !== undefined) {
    const expected = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
    const actual = payload["aud"];
    const actuals = Array.isArray(actual) ? actual : [actual];
    const match = actuals.some((a) => typeof a === "string" && expected.includes(a));
    if (!match) throw new UnauthorizedError("Invalid audience");
  }
}

/**
 * Verify a token and return its payload. Throws `UnauthorizedError` for
 * malformed tokens, bad signatures, algorithm/key mismatches, and failed
 * claims (`exp`/`nbf`/`iat`, optional `iss`/`aud`). Messages never include
 * the token or key material.
 */
export async function verify(
  token: string,
  key: JwtKey,
  opts: JwtVerifyOptions = {},
): Promise<JwtPayload> {
  const parts = token.split(".");
  const [hB64, pB64, sB64] = parts;
  if (parts.length !== 3 || hB64 === undefined || pB64 === undefined || sB64 === undefined) {
    throw new UnauthorizedError("Invalid token");
  }
  let header: unknown;
  let payload: unknown;
  try {
    const dec = new TextDecoder();
    header = JSON.parse(dec.decode(base64UrlToBytes(hB64)));
    payload = JSON.parse(dec.decode(base64UrlToBytes(pB64)));
  } catch {
    throw new UnauthorizedError("Invalid token");
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new UnauthorizedError("Invalid token");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new UnauthorizedError("Invalid token");
  }
  const alg = (header as { alg?: unknown }).alg;
  if (alg !== "HS256" && alg !== "RS256" && alg !== "ES256") {
    throw new UnauthorizedError("Unsupported algorithm");
  }
  if (opts.algorithms !== undefined && !opts.algorithms.includes(alg)) {
    throw new UnauthorizedError("Unexpected algorithm");
  }
  // Raw secrets only ever speak HS256 — refuse anything else outright
  // (blocks `alg` confusion between symmetric and asymmetric keys).
  if ((typeof key === "string" || key instanceof Uint8Array) && alg !== "HS256") {
    throw new UnauthorizedError("Unexpected algorithm");
  }
  if (isJwk(key)) {
    const kty = key.kty;
    if (
      (alg === "HS256" && kty !== "oct") ||
      (alg === "RS256" && kty !== "RSA") ||
      (alg === "ES256" && kty !== "EC")
    ) {
      throw new UnauthorizedError("Key type mismatch");
    }
  }
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64UrlToBytes(sB64);
  } catch {
    throw new UnauthorizedError("Invalid token");
  }
  const cryptoKey = await importKeyMaterial(alg, key, "verify");
  let ok = false;
  try {
    ok = await subtle().verify(signParams(alg), cryptoKey, sig, utf8(`${hB64}.${pB64}`));
  } catch {
    throw new UnauthorizedError("Invalid signature");
  }
  if (!ok) throw new UnauthorizedError("Invalid signature");
  const claims = payload as JwtPayload;
  assertClaims(claims, opts);
  return claims;
}

/**
 * Decode a token WITHOUT verifying. Returns `{header, payload}`. Throws a
 * plain `Error` on malformed input — never use the result for auth.
 */
export function decode(token: string): JwtDecoded {
  const parts = token.split(".");
  const [hB64, pB64] = parts;
  if (parts.length !== 3 || hB64 === undefined || pB64 === undefined) {
    throw new Error("Invalid token format");
  }
  try {
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(base64UrlToBytes(hB64))) as JwtHeader;
    const payload = JSON.parse(dec.decode(base64UrlToBytes(pB64))) as JwtPayload;
    if (typeof header !== "object" || header === null) throw new Error("Invalid token format");
    if (typeof payload !== "object" || payload === null) throw new Error("Invalid token format");
    return { header, payload };
  } catch (e) {
    if (e instanceof Error && e.message === "Invalid token format") throw e;
    throw new Error("Invalid token format");
  }
}

export interface JwtMiddlewareOptions {
  /** Raw HS256 secret (alias of `key` for the symmetric case). */
  secret?: JwtKey;
  /** Verification key (secret, CryptoKey, or JWK). */
  key?: JwtKey;
  /** JWKS to match by `kid`. */
  jwks?: { keys: JwtJwk[] };
  /** Pin a single accepted algorithm. */
  alg?: JwtAlgorithm;
  /** Pin several accepted algorithms. */
  algorithms?: JwtAlgorithm[];
  /** Cookie name to read the token from (falls back to the header). */
  cookie?: string;
  /** Header carrying the Bearer token (default `"authorization"`). */
  header?: string;
  /** Required `iss`. */
  issuer?: string | string[];
  /** Required `aud`. */
  audience?: string | string[];
  /** Leeway in seconds for time claims. */
  clockToleranceSec?: number;
}

/** State key the verified payload is stored under (`c.get("jwtPayload")`). */
export const JWT_PAYLOAD_KEY = "jwtPayload";

function unauthorized(c: Context, message = "Unauthorized"): Response {
  const res = new Response(JSON.stringify({ error: message, status: 401, code: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  c.setResponse(res);
  return res;
}

/**
 * Bearer-token auth middleware. Reads `Authorization: Bearer <token>` (or the
 * configured cookie, with header fallback), verifies, stores the payload via
 * `c.set("jwtPayload", payload)`, and calls `next()`. Failures return `401`
 * JSON directly and never reach downstream handlers.
 */
export function jwt(opts: JwtMiddlewareOptions): Handler {
  const single = opts.key ?? opts.secret;
  if (!single && !opts.jwks) {
    throw new Error("jwt middleware requires secret, key, or jwks");
  }
  const headerName = opts.header ?? "authorization";
  const algorithms = opts.alg !== undefined ? [opts.alg] : opts.algorithms;

  return async (c, next) => {
    let token: string | undefined;
    if (opts.cookie) {
      const cookieHeader = c.header("cookie");
      if (cookieHeader) {
        try {
          const found = parseCookie(cookieHeader)[opts.cookie];
          if (found) token = found;
        } catch {
          return unauthorized(c);
        }
      }
    }
    if (!token) {
      const h = c.header(headerName);
      if (h) {
        // `<scheme> <token>` split — scheme match is case-insensitive per RFC 7235.
        const bits = h.trim().split(/\s+/);
        if (bits.length === 2 && /^bearer$/i.test(bits[0] as string)) {
          token = bits[1] as string;
        }
      }
    }
    if (!token) return unauthorized(c);

    try {
      let key: JwtKey;
      if (opts.jwks) {
        let kid: string | undefined;
        try {
          const decoded = decode(token);
          kid = typeof decoded.header.kid === "string" ? decoded.header.kid : undefined;
        } catch {
          return unauthorized(c);
        }
        const keys = opts.jwks.keys;
        const jwk =
          kid !== undefined
            ? keys.find((k) => k.kid === kid)
            : keys.length === 1
              ? keys[0]
              : undefined;
        if (!jwk) return unauthorized(c, "Invalid key");
        key = jwk;
      } else {
        key = single as JwtKey;
      }
      const payload = await verify(token, key, {
        clockToleranceSec: opts.clockToleranceSec,
        issuer: opts.issuer,
        audience: opts.audience,
        ...(algorithms !== undefined ? { algorithms } : {}),
      });
      c.set(JWT_PAYLOAD_KEY, payload);
      await next();
      return;
    } catch (e) {
      if (e instanceof UnauthorizedError) return unauthorized(c, e.message);
      return unauthorized(c);
    }
  };
}

export type TokenMode = "auto" | "jwt" | "paseto";

export interface TokenMiddlewareOptions {
  /**
   * Which format to accept. `auto` (default) routes `v4.*` tokens to PASETO
   * and everything else to JWT. Pin to one side to reject the other outright.
   */
  mode?: TokenMode;
  /** Options for the JWT path (required when JWT tokens must verify). */
  jwt?: JwtMiddlewareOptions;
  /** Options for the PASETO path (required when PASETO tokens must verify). */
  paseto?: PasetoMiddlewareOptions;
  /** Header override applied to both paths (default `"authorization"`). */
  header?: string;
  /** Cookie-name override applied to both paths. */
  cookie?: string;
}

/** State key the verified payload is stored under (`c.get("tokenPayload")`). */
export const TOKEN_PAYLOAD_KEY = "tokenPayload";

/**
 * Switchable token middleware — one entry point for JWT and PASETO v4.
 * The verified payload is stored under both `c.get("tokenPayload")` and the
 * format-specific key (`jwtPayload` / `pasetoPayload`). Unconfigured or
 * mismatched formats return `401` JSON directly.
 */
export function token(opts: TokenMiddlewareOptions): Handler {
  const mode = opts.mode ?? "auto";
  const header = opts.header;
  const cookie = opts.cookie;
  const jwtOpts = opts.jwt
    ? {
        ...opts.jwt,
        ...(header !== undefined ? { header } : {}),
        ...(cookie !== undefined ? { cookie } : {}),
      }
    : undefined;
  const pasetoOpts = opts.paseto
    ? {
        ...opts.paseto,
        ...(header !== undefined ? { header } : {}),
        ...(cookie !== undefined ? { cookie } : {}),
      }
    : undefined;
  const jwtMw = jwtOpts ? jwt(jwtOpts) : undefined;
  const pasetoMw = pasetoOpts ? paseto(pasetoOpts) : undefined;
  if (!jwtMw && !pasetoMw) {
    throw new Error("token middleware requires jwt or paseto options");
  }

  return async (c, next) => {
    const headerName = header ?? "authorization";
    let raw: string | undefined;
    const cookieName = cookie ?? jwtOpts?.cookie ?? pasetoOpts?.cookie;
    if (cookieName) {
      const cookieHeader = c.header("cookie");
      if (cookieHeader) {
        try {
          const found = parseCookie(cookieHeader)[cookieName];
          if (found) raw = found;
        } catch {
          return unauthorized(c);
        }
      }
    }
    if (!raw) {
      const h = c.header(headerName);
      if (h) {
        const bits = h.trim().split(/\s+/);
        if (bits.length === 2 && /^bearer$/i.test(bits[0] as string)) raw = bits[1] as string;
      }
    }
    if (!raw) return unauthorized(c);
    // Verify first with a probe `next` (inner middlewares set their specific
    // key BEFORE calling next, so a passed probe means verified). Only then
    // publish `tokenPayload` and run the real downstream — setting state
    // after `next()` would be invisible to handlers (onion ordering).
    const isPaseto = raw.startsWith("v4.");
    const useJwt = mode === "jwt" || (!isPaseto && mode === "auto");
    const mw = useJwt ? jwtMw : pasetoMw;
    const specificKey = useJwt ? JWT_PAYLOAD_KEY : PASETO_PAYLOAD_KEY;
    if (!mw) return unauthorized(c);
    let verified = false;
    const probeNext = async (): Promise<void> => {
      verified = true;
    };
    const res = await mw(c, probeNext);
    if (!verified) return res ?? c.res ?? unauthorized(c);
    c.set(TOKEN_PAYLOAD_KEY, c.get(specificKey));
    await next();
    return;
  };
}
