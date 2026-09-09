/**
 * @minostack/cache — replaceable cache port + memory implementation.
 *
 * Dev-mode preview. Application code depends on `Cache`, never on the
 * backend. Clocks are injectable for deterministic TTL tests.
 *
 * ```ts
 * import { MemoryCache, cacheAside } from "@minostack/cache";
 *
 * const cache = new MemoryCache();
 * const user = await cacheAside(cache, "users/1", () => db.find(1), 60_000);
 * ```
 */

export interface Clock {
  now(): number;
}

/** Fixed clock for tests. */
export function fixedClock(at: number): Clock & { advance(ms: number): void } {
  let t = at;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export interface Cache<T = unknown> {
  get(key: string): T | undefined | Promise<T | undefined>;
  set(key: string, value: T, ttlMs?: number): void | Promise<void>;
  del(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

/**
 * Single-process memory cache with per-entry TTL and an entry cap.
 * Expired entries are pruned lazily on access; the oldest entry is evicted
 * when the cap is exceeded.
 */
export class MemoryCache<T = unknown> implements Cache<T> {
  private entries = new Map<string, { value: T; exp?: number }>();
  private readonly cap: number;
  private readonly now: () => number;

  constructor(opts: { maxEntries?: number; clock?: Clock } = {}) {
    this.cap = Math.max(1, Math.floor(opts.maxEntries ?? 10000));
    this.now = opts.clock?.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.exp !== undefined && e.exp <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (!this.entries.has(key) && this.entries.size >= this.cap) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, {
      value,
      exp: ttlMs === undefined ? undefined : this.now() + ttlMs,
    });
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Prefix every key — isolates tenants/features sharing one backend. */
export function namespaced<T>(prefix: string, inner: Cache<T>): Cache<T> {
  const key = (k: string): string => `${prefix}:${k}`;
  return {
    get: (k) => inner.get(key(k)),
    set: (k, v, ttl) => inner.set(key(k), v, ttl),
    del: (k) => inner.del(key(k)),
    clear: () => inner.clear(),
  };
}

/**
 * Cache-aside helper. Misses call `loader` once and store the result;
 * loader failures are never cached (failures degrade explicitly).
 */
export async function cacheAside<T>(
  cache: Cache<T>,
  key: string,
  loader: () => T | Promise<T>,
  ttlMs?: number,
): Promise<T> {
  const hit = await cache.get(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  await cache.set(key, value, ttlMs);
  return value;
}

const NEGATIVE = "__mino_negative__";

/**
 * Negative-caching wrapper. `getOrLoad` stores loader misses (`undefined`)
 * as markers for `negativeTtlMs`, so hot misses don't hammer the backend.
 * Plain `get` maps markers back to `undefined`.
 */
export function withNegativeCache<T>(inner: Cache<T | string>): Cache<T> & {
  getOrLoad(
    key: string,
    loader: () => T | undefined | Promise<T | undefined>,
    opts?: { ttlMs?: number; negativeTtlMs?: number },
  ): Promise<T | undefined>;
} {
  return {
    async get(key: string): Promise<T | undefined> {
      const v = await inner.get(key);
      return v === NEGATIVE ? undefined : (v as T | undefined);
    },
    set: (key, value, ttlMs) => inner.set(key, value, ttlMs),
    del: (key) => inner.del(key),
    clear: () => inner.clear(),
    async getOrLoad(
      key: string,
      loader: () => T | undefined | Promise<T | undefined>,
      opts: { ttlMs?: number; negativeTtlMs?: number } = {},
    ): Promise<T | undefined> {
      const hit = await inner.get(key);
      if (hit !== undefined) return hit === NEGATIVE ? undefined : (hit as T);
      const value = await loader();
      if (value === undefined) {
        await inner.set(key, NEGATIVE, opts.negativeTtlMs);
      } else {
        await inner.set(key, value, opts.ttlMs);
      }
      return value;
    },
  };
}

/**
 * Stampede protection (singleflight): concurrent `getOrLoad` calls for the
 * same key share one loader promise. Failures clear the slot so the next
 * caller retries.
 */
export function withStampede<T>(inner: Cache<T>): Cache<T> & {
  getOrLoad(key: string, loader: () => T | Promise<T>, ttlMs?: number): Promise<T>;
} {
  const inflight = new Map<string, Promise<T>>();
  const base: Cache<T> = {
    get: (k) => inner.get(k),
    set: (k, v, ttl) => inner.set(k, v, ttl),
    del: (k) => {
      inflight.delete(k);
      return inner.del(k);
    },
    clear: () => {
      inflight.clear();
      return inner.clear();
    },
  };
  return {
    ...base,
    async getOrLoad(key: string, loader: () => T | Promise<T>, ttlMs?: number): Promise<T> {
      const hit = await inner.get(key);
      if (hit !== undefined) return hit;
      const running = inflight.get(key);
      if (running) return running;
      const p = (async (): Promise<T> => {
        try {
          const value = await loader();
          await inner.set(key, value, ttlMs);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
  };
}
