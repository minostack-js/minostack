import { describe, it, expect } from "vitest";
import { Mino, HttpError } from "../src/index.js";
import { withRetry, isRetryableStatus } from "../src/retry.js";
import { CircuitBreaker, CircuitOpenError } from "../src/circuit-breaker.js";
import { Bulkhead, bulkhead } from "../src/bulkhead.js";
import { idempotency, MemoryIdempotencyStore } from "../src/idempotency.js";
import { proxy, isTargetAllowed } from "../src/proxy.js";

describe("P2: retry with budgets", () => {
  it("succeeds after transient failures with doubling backoff", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const v = await withRetry(
      () => {
        if (++calls < 3) throw new TypeError("conn reset");
        return "ok";
      },
      { maxAttempts: 3, backoffMs: 100, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(v).toBe("ok");
    expect(sleeps).toEqual([100, 200]);
  });

  it("rethows the last error and never wraps it", async () => {
    const err = new HttpError(503, "down", { expose: true, code: "x" });
    await expect(
      withRetry(() => Promise.reject(err), { maxAttempts: 2, sleep: async () => {} }),
    ).rejects.toBe(err);
  });

  it("does not retry 4xx by default; custom predicate opts in", async () => {
    let n = 0;
    await expect(
      withRetry(
        () => {
          n++;
          throw new HttpError(400, "bad", { expose: true });
        },
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(n).toBe(1);
    let m = 0;
    await expect(
      withRetry(
        () => {
          m++;
          throw new HttpError(400, "bad", { expose: true });
        },
        { shouldRetry: () => true, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(m).toBe(3);
  });

  it("honors the overall deadline", async () => {
    let now = 0;
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          throw new Error("down");
        },
        {
          backoffMs: 1000,
          timeoutMs: 1500,
          sleep: async () => {
            now += 1000;
          },
          now: () => now,
        },
      ),
    ).rejects.toThrow("down");
    expect(calls).toBe(2);
  });

  it("isRetryableStatus classifies 408/429/5xx", () => {
    expect([408, 429, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe("P2: circuit breaker", () => {
  it("opens after threshold, fails fast, probes closed after reset", async () => {
    let now = 0;
    const transitions: string[] = [];
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      now: () => now,
      onStateChange: (f, t) => void transitions.push(`${f}->${t}`),
    });
    expect(cb.getState()).toBe("closed");
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cb.consecutiveFailures).toBe(1);
    await expect(cb.execute(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cb.getState()).toBe("open");
    let upstream = 0;
    await expect(
      cb.execute(() => {
        upstream++;
        return "x";
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(upstream).toBe(0);
    now += 1000;
    expect(cb.getState()).toBe("half-open");
    expect(await cb.execute(() => "recovered")).toBe("recovered");
    expect(cb.getState()).toBe("closed");
    expect(transitions).toEqual(["closed->open", "open->half-open", "half-open->closed"]);
  });

  it("half-open failure re-opens; 4xx never counts", async () => {
    let now = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => now });
    await expect(
      cb.execute(() => Promise.reject(new HttpError(400, "bad", { expose: true }))),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(cb.getState()).toBe("closed");
    expect(cb.consecutiveFailures).toBe(0);
    await expect(cb.execute(() => Promise.reject(new Error("down")))).rejects.toThrow();
    expect(cb.getState()).toBe("open");
    now += 100;
    await expect(cb.execute(() => Promise.reject(new Error("still down")))).rejects.toThrow();
    expect(cb.getState()).toBe("open");
    cb.reset();
    expect(cb.getState()).toBe("closed");
  });

  it("custom classifier and half-open call budget", async () => {
    let now = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 10,
      halfOpenMaxCalls: 1,
      isFailure: (e) => (e as Error).message === "fatal",
      now: () => now,
    });
    await expect(cb.execute(() => Promise.reject(new Error("transient")))).rejects.toThrow(
      "transient",
    );
    expect(cb.getState()).toBe("closed");
    await expect(cb.execute(() => Promise.reject(new Error("fatal")))).rejects.toThrow("fatal");
    now += 10;
    expect(await cb.execute(() => "probe")).toBe("probe");
    await expect(cb.execute(() => Promise.reject(new Error("fatal")))).rejects.toThrow("fatal");
    now += 10;
    expect(await cb.execute(() => "p1")).toBe("p1");
    expect(cb.getState()).toBe("closed");
  });
});

describe("P2: bulkhead", () => {
  it("saturates fast with 429 + Retry-After, isolates unrelated work", async () => {
    const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 1, retryAfterSec: 7 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = bh.execute(() => gate);
    const second = bh.execute(() => "queued");
    const third = bh.execute(() => "nope");
    await expect(third).rejects.toMatchObject({ status: 429 });
    try {
      await third;
    } catch (e) {
      expect((e as HttpError).toResponse().headers.get("retry-after")).toBe("7");
    }
    expect(bh.stats()).toMatchObject({ active: 1, queued: 1 });
    release();
    expect(await first).toBeUndefined();
    expect(await second).toBe("queued");
    expect(bh.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("middleware form guards routes without touching others", async () => {
    const app = new Mino();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.post("/heavy", bulkhead({ maxConcurrent: 1 }), async (c) => {
      await gate;
      return c.text("done");
    });
    app.get("/light", (c) => c.text("fast"));
    const pending = app.fetch(new Request("http://localhost/heavy", { method: "POST" }));
    const saturated = await app.fetch(new Request("http://localhost/heavy", { method: "POST" }));
    expect(saturated.status).toBe(429);
    expect(await (await app.fetch(new Request("http://localhost/light"))).text()).toBe("fast");
    release();
    expect((await pending).status).toBe(200);
  });
});

describe("P2: idempotency keys", () => {
  it("executes once, replays duplicates, conflicts on reuse", async () => {
    const store = new MemoryIdempotencyStore();
    const app = new Mino();
    let charges = 0;
    app.post("/pay", idempotency(store), (c) => {
      charges++;
      return c.json({ charged: charges }, 201);
    });
    const headers = { "idempotency-key": "k-1", "content-type": "application/json" };
    const r1 = await app.fetch(new Request("http://localhost/pay", { method: "POST", headers }));
    expect(r1.status).toBe(201);
    const r2 = await app.fetch(new Request("http://localhost/pay", { method: "POST", headers }));
    expect(r2.status).toBe(201);
    expect(await r2.json()).toEqual({ charged: 1 });
    expect(charges).toBe(1);
    const other = await app.fetch(
      new Request("http://localhost/other?x=1", { method: "POST", headers }),
    );
    expect(other.status).toBe(404);
    // Same key, different fingerprint → 409
    const app2 = new Mino();
    app2.post("/a", idempotency(store), (c) => c.text("a"));
    app2.post("/b", idempotency(store), (c) => c.text("b"));
    await app2.fetch(new Request("http://localhost/a", { method: "POST", headers }));
    const conflict = await app2.fetch(
      new Request("http://localhost/b", { method: "POST", headers }),
    );
    expect(conflict.status).toBe(409);
  });

  it("safe methods and keyless requests pass through; errors are not stored", async () => {
    const store = new MemoryIdempotencyStore();
    const app = new Mino();
    let n = 0;
    app.get("/g", idempotency(store), (c) => c.text(`g${++n}`));
    app.post("/p", idempotency(store), (c) => c.text(`p${++n}`));
    app.post("/e", idempotency(store), (c) => {
      n++;
      throw new HttpError(500, "boom", { expose: false });
    });
    const h = { "idempotency-key": "k" };
    expect(await (await app.fetch(new Request("http://localhost/g", { headers: h }))).text()).toBe(
      "g1",
    );
    expect(await (await app.fetch(new Request("http://localhost/g", { headers: h }))).text()).toBe(
      "g2",
    );
    expect(
      await (await app.fetch(new Request("http://localhost/p", { method: "POST" }))).text(),
    ).toBe("p3");
    expect(
      (await app.fetch(new Request("http://localhost/e", { method: "POST", headers: h }))).status,
    ).toBe(500);
    expect(store.size).toBe(0);
  });

  it("custom fingerprint binds the body; TTL expires entries", async () => {
    let now = 0;
    const store = new MemoryIdempotencyStore({ clock: { now: () => now } });
    const app = new Mino();
    let n = 0;
    app.post("/s", idempotency(store, { fingerprint: (c, key) => `${key}` }), (c) =>
      c.text(`n${++n}`),
    );
    const h = { "idempotency-key": "k" };
    await app.fetch(new Request("http://localhost/s", { method: "POST", headers: h }));
    expect(
      await (
        await app.fetch(new Request("http://localhost/s", { method: "POST", headers: h }))
      ).text(),
    ).toBe("n1");
    now += 25 * 60 * 60 * 1000;
    expect(
      await (
        await app.fetch(new Request("http://localhost/s", { method: "POST", headers: h }))
      ).text(),
    ).toBe("n2");
  });
});

describe("P2: proxy hardening", () => {
  it("isTargetAllowed matches origins, regexes, and functions", () => {
    const u = new URL("https://api.example.com/v1/x");
    expect(isTargetAllowed(u, undefined)).toBe(true);
    expect(isTargetAllowed(u, [])).toBe(false);
    expect(isTargetAllowed(u, ["https://api.example.com"])).toBe(true);
    expect(isTargetAllowed(u, ["https://other.example.com"])).toBe(false);
    expect(isTargetAllowed(u, [/^https:\/\/api\./])).toBe(true);
    expect(isTargetAllowed(u, () => false)).toBe(false);
  });

  it("proxy denies disallowed targets with generic 502", async () => {
    const app = new Mino();
    let called = 0;
    app.all(
      "/api/*",
      proxy("http://127.0.0.1:9", {
        allowedTargets: ["https://api.example.com"],
        fetchFn: async () => {
          called++;
          return new Response("x");
        },
      }),
    );
    const res = await app.fetch(new Request("http://localhost/api/users"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bad Gateway", status: 502, code: "bad_gateway" });
    expect(called).toBe(0);
  });

  it("proxy composes with injected fetch (retry/breaker policies)", async () => {
    const app = new Mino();
    const seen: string[] = [];
    app.all(
      "/api/*",
      proxy("https://api.example.com", {
        fetchFn: async (url, init) => {
          seen.push(`${init?.method} ${url}`);
          return new Response("upstream", { headers: { "x-u": "1" } });
        },
      }),
    );
    const res = await app.fetch(new Request("http://localhost/api/a?b=1"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream");
    expect(seen).toEqual(["GET https://api.example.com/api/a?b=1"]);
  });
});
