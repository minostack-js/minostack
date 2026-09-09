/**
 * `@minostack/mino/cache` — in-memory GET memo middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Request`/`Response` + `Date.now()` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { cache } from "@minostack/mino/cache";
 *
 * const app = new Mino();
 * app.use(cache({ ttlMs: 60_000 }));
 * ```
 *
 * Only listed methods (default `["GET"]`, case-insensitive) are cached, keyed
 * by `` `${METHOD}:${url}` `` (full URL, query included — the body is never
 * part of the key). Requests carrying `authorization` bypass (and never
 * populate) unless `private:true`; requests with `cache-control: no-cache`
 * bypass too. A fresh entry answers `x-cache: HIT`; a downstream `200` with a
 * body is buffered (single entries over 5MB are served but not stored), stored
 * as a copy, and served as `x-cache: MISS`. Non-200s and bodyless 200s pass
 * through unmarked and are never stored.
 *
 * Expired entries are dropped lazily on access; inserts prune expired entries
 * first, then evict oldest-first (FIFO, `Map` insertion order) past
 * `maxEntries` (default 1000, same pattern as `rate-limit.ts` buckets).
 * Staleness bound: an entry is served at most `ttlMs` old (default 60s);
 * there is no revalidation and no `Age` header. Single process only — put
 * shared infrastructure in front for multi-instance deployments. Nothing is
 * logged (cached bodies may carry PII — never log them).
 */

import type { Handler } from "./types.js";

export interface CacheOptions {
  /** Entry lifetime in ms (default `60000`). Bounds staleness. */
  ttlMs?: number;
  /** Max stored entries; oldest-first eviction past the cap (default `1000`). */
  maxEntries?: number;
  /** Methods eligible for caching (default `["GET"]`, case-insensitive). */
  methods?: string[];
  /**
   * When true, requests with `authorization` are cached too (default false —
   * per-user responses must not be shared across users).
   */
  private?: boolean;
}

interface CacheEntry {
  status: number;
  statusText: string;
  headers: Headers;
  body: Uint8Array;
  expires: number;
}

/** Single entries larger than this are served but never stored. */
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;

function prune(store: Map<string, CacheEntry>, maxEntries: number, now: number): void {
  if (store.size < maxEntries) return;
  // Drop expired first so live entries survive sizing pressure when possible.
  for (const [key, entry] of store) {
    if (entry.expires <= now) store.delete(key);
  }
  // Still over cap → evict oldest-first (Map preserves insertion order).
  for (const [key] of store) {
    if (store.size < maxEntries) break;
    store.delete(key);
  }
}

export function cache(opts: CacheOptions = {}): Handler {
  const ttlMs = opts.ttlMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 1000;
  const methods = new Set((opts.methods ?? ["GET"]).map((m) => m.toUpperCase()));
  const sharedPrivate = opts.private ?? false;
  const store = new Map<string, CacheEntry>();

  return async (c, next) => {
    const method = c.method.toUpperCase();
    if (!methods.has(method)) {
      await next();
      return;
    }
    // Authorized responses are per-user: bypass unless explicitly private.
    if (!sharedPrivate && c.header("authorization") !== undefined) {
      await next();
      return;
    }
    if ((c.header("cache-control") ?? "").includes("no-cache")) {
      await next();
      return;
    }
    const key = `${method}:${c.req.url}`;
    const now = Date.now();
    const hit = store.get(key);
    if (hit !== undefined) {
      if (hit.expires > now) {
        const headers = new Headers(hit.headers);
        headers.set("x-cache", "HIT");
        const out = new Response(hit.body as unknown as BodyInit, {
          status: hit.status,
          statusText: hit.statusText,
          headers,
        });
        c.setResponse(out);
        return out;
      }
      // Lazily drop the stale entry; the miss path below re-populates.
      store.delete(key);
    }
    await next();
    const res = c.res;
    if (!res) return;
    if (res.status !== 200 || res.body === null) return;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      return;
    }
    // Rebuild is required: the body was consumed by buffering, and Fetch
    // Response headers are immutable.
    const headers = new Headers(res.headers);
    headers.set("x-cache", "MISS");
    // NOTE: must RETURN the rebuilt response — compose() prefers nextResult
    // over c.res, so setResponse alone would be discarded by the dispatcher.
    const out = new Response(bytes as unknown as BodyInit, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
    c.setResponse(out);
    if (bytes.byteLength <= MAX_ENTRY_BYTES) {
      prune(store, maxEntries, Date.now());
      store.set(key, {
        status: res.status,
        statusText: res.statusText,
        headers: new Headers(res.headers),
        body: bytes.slice(),
        expires: Date.now() + ttlMs,
      });
    }
    return out;
  };
}
