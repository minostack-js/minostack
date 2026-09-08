/**
 * `@minostack/mino/rate-limit` — fixed-window rate limiting middleware.
 *
 * Zero dependencies, runtime-agnostic. In-memory buckets (single process).
 * For multi-instance deployments put a shared gateway/limiter in front.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { rateLimit } from "@minostack/mino/rate-limit";
 *
 * const app = new Mino({ trustProxy: 1 });
 * app.use(rateLimit({ windowMs: 60_000, max: 100, trustProxy: 1 }));
 * ```
 *
 * Key resolution order: explicit `key()` → server-set `x-mino-peer` header
 * (written by runtime adapters from the socket, overwriting client values) →
 * `X-Forwarded-For` when `trustProxy` allows → `"global"` fallback bucket.
 * Untrusted `X-Forwarded-For` is always ignored (client-spoofable).
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";

export interface RateLimitOptions {
  /** Window length in ms (default 60000). */
  windowMs?: number;
  /** Max requests per window per key (default 100). */
  max?: number;
  /** Custom bucket key. Default: peer IP resolution (see `clientIp`). */
  key?: (c: Context) => string;
  /**
   * Proxy trust for `X-Forwarded-For` — same semantics as `MinoOptions.trustProxy`.
   * Pass the same value your app was constructed with.
   */
  trustProxy?: boolean | number;
  /** Emit `RateLimit-*` + `Retry-After` headers (default true). */
  headers?: boolean;
}

/**
 * Resolve the client IP for trust decisions. Never throws; falls back to
 * `"global"` when no trustworthy signal exists (documented behavior — such
 * deployments share one bucket and are still protected as a whole).
 */
export function clientIp(c: Context, trustProxy?: boolean | number): string {
  const peer = c.header("x-mino-peer");
  const xff = c.header("x-forwarded-for");
  if (trustProxy === true && xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  } else if (typeof trustProxy === "number" && xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Drop the N trusted closest hops from the right; client is the last
    // remaining entry. Nothing remaining → fall through to peer.
    const idx = parts.length - trustProxy - 1;
    if (idx >= 0) {
      const ip = parts[idx];
      if (ip) return ip;
    }
  }
  if (peer) return peer;
  return "global";
}

interface Bucket {
  count: number;
  reset: number;
}

const MAX_BUCKETS = 10000;

export function rateLimit(opts: RateLimitOptions = {}): Handler {
  const windowMs = opts.windowMs ?? 60000;
  const max = opts.max ?? 100;
  const emitHeaders = opts.headers ?? true;
  const buckets = new Map<string, Bucket>();

  function prune(now: number): void {
    if (buckets.size <= MAX_BUCKETS) return;
    for (const [k, b] of buckets) {
      if (b.reset <= now) buckets.delete(k);
      if (buckets.size <= MAX_BUCKETS - 1000) break;
    }
  }

  return async (c, next) => {
    const key = opts.key
      ? opts.key(c as unknown as Context)
      : clientIp(c as unknown as Context, opts.trustProxy);
    const now = Date.now();
    prune(now);
    let b = buckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    const remaining = Math.max(0, max - b.count);
    const retryAfter = Math.max(0, Math.ceil((b.reset - now) / 1000));

    if (b.count > max) {
      const h = new Headers();
      h.set("content-type", "application/json; charset=utf-8");
      if (emitHeaders) {
        h.set("ratelimit-limit", String(max));
        h.set("ratelimit-remaining", "0");
        h.set("ratelimit-reset", String(retryAfter));
        h.set("retry-after", String(retryAfter));
      }
      c.setResponse(
        new Response(
          JSON.stringify({ error: "Too Many Requests", status: 429, code: "too_many_requests" }),
          { status: 429, headers: h },
        ),
      );
      return;
    }

    await next();
    if (emitHeaders && c.res) {
      const h = new Headers(c.res.headers);
      h.set("ratelimit-limit", String(max));
      h.set("ratelimit-remaining", String(remaining));
      h.set("ratelimit-reset", String(retryAfter));
      // NOTE: return (not just setResponse) — compose() prefers nextResult.
      const out = new Response(c.res.body, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: h,
      });
      c.setResponse(out);
      return out;
    }
  };
}
