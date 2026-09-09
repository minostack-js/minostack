/**
 * `@minostack/mino/etag` — ETag generation + conditional-request middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Response` only, sync FNV-1a hash).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { etag, conditional } from "@minostack/mino/etag";
 *
 * const app = new Mino();
 * app.use(etag());
 * ```
 *
 * `etag()` buffers the downstream response, sets a `"<len>-<hash>"` validator
 * (`W/`-prefixed when `weak`, the default), and — unless `notModified:false` —
 * answers `304` when `If-None-Match` / `If-Modified-Since` preconditions match.
 * `conditional()` alone only evaluates preconditions against the `ETag` /
 * `Last-Modified` already present on the response.
 */

import type { Handler } from "./types.js";

export interface ETagOptions {
  /** Emit weak validators (`W/"…"`, default true). Set false for strong tags. */
  weak?: boolean;
  /** Evaluate `If-None-Match` / `If-Modified-Since` and answer `304` (default true). */
  notModified?: boolean;
}

/** FNV-1a 32-bit hash rendered as 8 lowercase hex chars. */
function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build a strong ETag value (`"<len>-<hash>"`, quoted) for raw body bytes.
 * The `weak` prefix is applied by the middleware, never here.
 */
export function generateETag(bytes: Uint8Array): string {
  return `"${bytes.byteLength}-${fnv1aHex(bytes)}"`;
}

function stripWeak(tag: string): string {
  const t = tag.trim();
  return t.startsWith("W/") ? t.slice(2).trim() : t;
}

function ifNoneMatchHits(header: string, etag: string): boolean {
  const want = stripWeak(etag);
  for (const part of header.split(",")) {
    const token = part.trim();
    if (token === "*") return true;
    if (token && stripWeak(token) === want) return true;
  }
  return false;
}

/** Build a bodyless `304` preserving validators and cache metadata. */
function notModifiedResponse(res: Response): Response {
  const h = new Headers();
  const etag = res.headers.get("etag");
  if (etag) h.set("etag", etag);
  const lastModified = res.headers.get("last-modified");
  if (lastModified) h.set("last-modified", lastModified);
  const cacheControl = res.headers.get("cache-control");
  if (cacheControl) h.set("cache-control", cacheControl);
  const vary = res.headers.get("vary");
  if (vary) h.set("vary", vary);
  const expires = res.headers.get("expires");
  if (expires) h.set("expires", expires);
  return new Response(null, { status: 304, headers: h });
}

function checkPreconditions(
  reqEtag: string | undefined,
  reqIms: string | undefined,
  headers: Headers,
): boolean {
  const etag = headers.get("etag");
  if (reqEtag && etag && ifNoneMatchHits(reqEtag, etag)) return true;
  if (reqIms) {
    const lastModified = headers.get("last-modified");
    if (lastModified) {
      const imsTime = Date.parse(reqIms);
      const lmTime = Date.parse(lastModified);
      if (Number.isFinite(imsTime) && Number.isFinite(lmTime) && imsTime >= lmTime) return true;
    }
  }
  return false;
}

export function etag(opts: ETagOptions = {}): Handler {
  const weak = opts.weak ?? true;
  const notModified = opts.notModified ?? true;

  return async (c, next) => {
    await next();
    const res = c.res;
    if (!res) return;
    // Bodyless statuses carry no validator; event streams must not be buffered.
    if (res.status === 204 || res.status === 304) return;
    if (res.body === null) return;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) return;

    const h = new Headers(res.headers);
    let current = h.get("etag");
    let bytes: Uint8Array | null = null;
    if (!current) {
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch {
        return;
      }
      const strong = generateETag(bytes);
      current = weak ? `W/${strong}` : strong;
      h.set("etag", current);
    }

    const outHeaders = { headers: h, status: res.status, statusText: res.statusText };
    if (
      notModified &&
      checkPreconditions(
        c.header("if-none-match") ?? undefined,
        c.header("if-modified-since") ?? undefined,
        h,
      )
    ) {
      const notModifiedRes = notModifiedResponse(new Response(null, { headers: h }));
      c.setResponse(notModifiedRes);
      return notModifiedRes;
    }

    // Rebuild only when we added the validator; otherwise leave untouched.
    if (!res.headers.has("etag")) {
      const body: Uint8Array = bytes ?? new Uint8Array(0);
      const out = new Response(body as unknown as BodyInit, outHeaders);
      c.setResponse(out);
      return out;
    }
  };
}

/**
 * Evaluate `If-None-Match` / `If-Modified-Since` against the `ETag` and
 * `Last-Modified` already present on the downstream response.
 * Answers `304` with a stripped body on a match, passes through otherwise.
 */
export function conditional(): Handler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (!res) return;
    if (res.status === 304 || res.status === 204) return;
    if (!res.headers.has("etag") && !res.headers.has("last-modified")) return;
    if (
      checkPreconditions(
        c.header("if-none-match") ?? undefined,
        c.header("if-modified-since") ?? undefined,
        res.headers,
      )
    ) {
      const out = notModifiedResponse(res);
      c.setResponse(out);
      return out;
    }
  };
}
