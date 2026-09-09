import { describe, it, expect } from "vitest";
import {
  MemoryCache,
  namespaced,
  cacheAside,
  withNegativeCache,
  withStampede,
  fixedClock,
} from "../src/index.js";

describe("@minostack/cache", () => {
  it("stores, expires by TTL, and evicts oldest at cap", () => {
    const clock = fixedClock(0);
    const cache = new MemoryCache<string>({ maxEntries: 2, clock });
    cache.set("a", "1");
    cache.set("b", "2", 1000);
    expect(cache.get("a")).toBe("1");
    clock.advance(1001);
    expect(cache.get("b")).toBeUndefined();
    cache.set("c", "3");
    cache.set("d", "4");
    expect(cache.size).toBe(2);
    cache.del("c");
    expect(cache.get("c")).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("namespaces isolate keys", async () => {
    const inner = new MemoryCache<string>();
    const t1 = namespaced("tenant1", inner);
    const t2 = namespaced("tenant2", inner);
    await t1.set("k", "v1");
    expect(await t2.get("k")).toBeUndefined();
    expect(await t1.get("k")).toBe("v1");
  });

  it("cacheAside loads once and never caches failures", async () => {
    const cache = new MemoryCache<number>();
    let loads = 0;
    const v1 = await cacheAside(cache, "k", () => ++loads);
    const v2 = await cacheAside(cache, "k", () => ++loads);
    expect([v1, v2]).toEqual([1, 1]);
    expect(loads).toBe(1);
    await cache.del("k");
    let fail = 0;
    await expect(
      cacheAside(cache, "k", () => {
        fail++;
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(await cache.get("k")).toBeUndefined();
    expect(fail).toBe(1);
  });

  it("negative cache suppresses hot misses until TTL", async () => {
    const clock = fixedClock(0);
    const inner = new MemoryCache<string | undefined>({ clock });
    const cache = withNegativeCache<string>(inner as never);
    let loads = 0;
    const loader = (): string | undefined => {
      loads++;
      return undefined;
    };
    expect(await cache.getOrLoad("missing", loader, { negativeTtlMs: 1000 })).toBeUndefined();
    expect(await cache.getOrLoad("missing", loader, { negativeTtlMs: 1000 })).toBeUndefined();
    expect(loads).toBe(1);
    expect(await cache.get("missing")).toBeUndefined();
    clock.advance(1001);
    expect(await cache.getOrLoad("missing", loader, { negativeTtlMs: 1000 })).toBeUndefined();
    expect(loads).toBe(2);
  });

  it("stampede shares one loader across concurrent callers", async () => {
    const cache = withStampede(new MemoryCache<number>());
    let loads = 0;
    const loader = async (): Promise<number> => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.getOrLoad("k", loader)),
    );
    expect(results.every((r) => r === 42)).toBe(true);
    expect(loads).toBe(1);
    // Failures clear the slot so the next caller retries
    let attempts = 0;
    const flaky = (): Promise<number> => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(7);
    };
    await expect(cache.getOrLoad("e", flaky)).rejects.toThrow("boom");
    await expect(cache.getOrLoad("e", flaky)).resolves.toBe(7);
    expect(attempts).toBe(2);
  });
});

describe("@minostack/cache coverage", () => {
  it("namespaced del/clear delegate with prefix", async () => {
    const inner = new MemoryCache<string>();
    const ns = namespaced("t", inner);
    await ns.set("k", "v");
    await ns.del("k");
    expect(await ns.get("k")).toBeUndefined();
    await ns.set("k", "v");
    await ns.clear();
    expect(await ns.get("k")).toBeUndefined();
  });

  it("negative wrapper stores positives and delegates set/del/clear", async () => {
    const inner = new MemoryCache<string>();
    const cache = withNegativeCache<string>(inner);
    expect(await cache.getOrLoad("k", () => "v", { ttlMs: 1000 })).toBe("v");
    expect(await cache.getOrLoad("k", () => "other")).toBe("v");
    expect(await cache.get("k")).toBe("v");
    await cache.set("k2", "x");
    expect(await cache.get("k2")).toBe("x");
    await cache.del("k2");
    expect(await cache.get("k2")).toBeUndefined();
    await cache.clear();
    expect(await cache.get("k")).toBeUndefined();
  });

  it("stampede base delegates get/set/del/clear", async () => {
    const guarded = withStampede(new MemoryCache<number>());
    await guarded.set("k", 1);
    expect(await guarded.get("k")).toBe(1);
    await guarded.del("k");
    expect(await guarded.get("k")).toBeUndefined();
    await guarded.set("k", 1);
    await guarded.clear();
    expect(await guarded.get("k")).toBeUndefined();
  });
});
