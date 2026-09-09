import { describe, it, expect } from "vitest";
import { Mino } from "../src/index.js";
import { live, ready, createReadinessMonitor } from "../src/health.js";

describe("P3: health model", () => {
  it("live answers 200 without auth", async () => {
    const app = new Mino();
    app.get("/live", live());
    const res = await app.fetch(new Request("http://localhost/live"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "alive" });
  });

  it("ready aggregates checks; unhealthy → 503 not_ready + Retry-After", async () => {
    const app = new Mino();
    let dbUp = true;
    app.get(
      "/ready",
      ready({
        checks: {
          db: () => ({ healthy: dbUp, detail: "pg 16" }),
          cache: () => true,
        },
        retryAfterSec: 9,
      }),
    );
    const okRes = await app.fetch(new Request("http://localhost/ready"));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({ status: "ready" });
    dbUp = false;
    const down = await app.fetch(new Request("http://localhost/ready"));
    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("9");
    expect(await down.json()).toMatchObject({ code: "not_ready" });
  });

  it("slow checks time out; results cache for cacheMs", async () => {
    let calls = 0;
    let now = 0;
    const monitor = createReadinessMonitor({
      checks: {
        slow: async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 50));
          return true;
        },
      },
      timeoutMs: 5,
      cacheMs: 1000,
      now: () => now,
    });
    const r1 = await monitor.check();
    expect(r1.status).toBe("not-ready");
    expect(calls).toBe(1);
    const r2 = await monitor.check();
    expect(r2).toBe(r1);
    expect(calls).toBe(1);
    now += 1001;
    await monitor.check();
    expect(calls).toBe(2);
  });

  it("check throws count as unhealthy without leaking", async () => {
    const monitor = createReadinessMonitor({
      checks: {
        bad: () => {
          throw new Error("socket fd=3 password=hunter2");
        },
      },
    });
    const report = await monitor.check();
    expect(report.status).toBe("not-ready");
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });
});
