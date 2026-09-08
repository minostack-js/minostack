import { describe, it, expect, vi } from "vitest";
import { Mino } from "../src/mino.js";
import { helmet } from "../src/helmet.js";
import { cors } from "../src/cors.js";
import { rateLimit, clientIp } from "../src/rate-limit.js";
import { timeout } from "../src/timeout.js";
import { requestId, logger } from "../src/request-id.js";
import type { Context } from "../src/context.js";

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("secure: helmet", () => {
  it("sets defaults on plain responses", async () => {
    const app = new Mino();
    app.use(helmet());
    app.get("/", (c) => c.text("ok"));
    const res = await fetchVia(app, "/");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
  });

  it("never sends HSTS over http, sends it over https", async () => {
    const app = new Mino();
    app.use(helmet());
    app.get("/", (c) => c.text("ok"));
    expect((await fetchVia(app, "/")).headers.get("strict-transport-security")).toBe(null);
    const https = await app.fetch(new Request("https://localhost/"));
    expect(https.headers.get("strict-transport-security")).toContain("max-age=15552000");
    expect(https.headers.get("strict-transport-security")).toContain("includeSubDomains");
  });

  it("explicit handler headers win; flags disable", async () => {
    const app = new Mino();
    app.use(helmet({ frameGuard: false, contentSecurityPolicy: "default-src 'self'" }));
    app.get("/", (c) => {
      c.headerSet("x-frame-options", "DENY");
      return c.text("ok");
    });
    const res = await fetchVia(app, "/");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});

describe("secure: cors", () => {
  it("non-CORS requests pass through untouched", async () => {
    const app = new Mino();
    app.use(cors({ origin: "https://a.example.com" }));
    app.get("/", (c) => c.text("ok"));
    const res = await fetchVia(app, "/");
    expect(res.headers.get("access-control-allow-origin")).toBe(null);
    expect(await res.text()).toBe("ok");
  });

  it("preflight is answered 204 without touching routes", async () => {
    const app = new Mino();
    let routed = false;
    app.use(cors({ origin: "https://a.example.com", maxAge: 600 }));
    app.get("/", (c) => {
      routed = true;
      return c.text("ok");
    });
    const res = await fetchVia(app, "/", {
      method: "OPTIONS",
      headers: { origin: "https://a.example.com", "access-control-request-method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://a.example.com");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(routed).toBe(false);
  });

  it("disallowed origins get no ACA headers; allowed get ACAO+Vary", async () => {
    const app = new Mino();
    app.use(cors({ origin: [/^https:\/\/.*\.example\.com$/] }));
    app.get("/", (c) => c.text("ok"));
    const bad = await fetchVia(app, "/", { headers: { origin: "https://evil.test" } });
    expect(bad.headers.get("access-control-allow-origin")).toBe(null);
    const good = await fetchVia(app, "/", { headers: { origin: "https://x.example.com" } });
    expect(good.headers.get("access-control-allow-origin")).toBe("https://x.example.com");
    expect(good.headers.get("vary")).toContain("Origin");
  });

  it("credentials mode echoes origin, never star", async () => {
    const app = new Mino();
    app.use(cors({ origin: true, credentials: true }));
    app.get("/", (c) => c.text("ok"));
    const res = await fetchVia(app, "/", { headers: { origin: "https://any.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://any.test");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("secure: clientIp", () => {
  const ctx = (headers: Record<string, string>) =>
    ({
      header: (n: string) => headers[n.toLowerCase()],
    }) as unknown as Context;

  it("prefers server-set peer, ignores spoofed XFF when untrusted", () => {
    expect(clientIp(ctx({ "x-mino-peer": "10.0.0.1", "x-forwarded-for": "9.9.9.9" }))).toBe(
      "10.0.0.1",
    );
  });

  it("falls back to global bucket with no signal", () => {
    expect(clientIp(ctx({}))).toBe("global");
  });

  it("trustProxy true takes leftmost XFF; number drops N trusted hops", () => {
    const h = { "x-forwarded-for": "client, p1, p2" };
    expect(clientIp(ctx(h), true)).toBe("client");
    expect(clientIp(ctx(h), 2)).toBe("client");
    expect(clientIp(ctx(h), 1)).toBe("p1");
    // all hops trusted away → peer → global
    expect(clientIp(ctx(h), 5)).toBe("global");
  });
});

describe("secure: rate-limit", () => {
  it("allows max then 429s with Retry-After and shape", async () => {
    const app = new Mino();
    app.use(rateLimit({ windowMs: 60_000, max: 3 }));
    app.get("/", (c) => c.text("ok"));
    for (let i = 0; i < 3; i++) expect((await fetchVia(app, "/")).status).toBe(200);
    const limited = await fetchVia(app, "/");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeDefined();
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    expect(await limited.json()).toMatchObject({ status: 429, code: "too_many_requests" });
    // success responses carry remaining budget
    const fresh = new Mino();
    fresh.use(rateLimit({ windowMs: 60_000, max: 3 }));
    fresh.get("/", (c) => c.text("ok"));
    const first = await fetchVia(fresh, "/");
    expect(first.headers.get("ratelimit-remaining")).toBe("2");
  });

  it("buckets are per-key and windows reset", async () => {
    const app = new Mino();
    app.use(rateLimit({ windowMs: 50, max: 1, key: (c) => (c as Context).header("x-k") ?? "?" }));
    app.get("/", (c) => c.text("ok"));
    expect((await fetchVia(app, "/", { headers: { "x-k": "a" } })).status).toBe(200);
    expect((await fetchVia(app, "/", { headers: { "x-k": "a" } })).status).toBe(429);
    expect((await fetchVia(app, "/", { headers: { "x-k": "b" } })).status).toBe(200);
    await sleep(70);
    expect((await fetchVia(app, "/", { headers: { "x-k": "a" } })).status).toBe(200);
  });

  it("spoofed XFF does not escape the bucket when untrusted", async () => {
    const app = new Mino();
    app.use(rateLimit({ windowMs: 60_000, max: 1 }));
    app.get("/", (c) => c.text("ok"));
    expect((await fetchVia(app, "/")).status).toBe(200);
    // attacker rotates XFF — still the same global bucket → 429
    expect((await fetchVia(app, "/", { headers: { "x-forwarded-for": "1.2.3.4" } })).status).toBe(
      429,
    );
  });
});

describe("secure: timeout", () => {
  it("fast handlers are untouched", async () => {
    const app = new Mino();
    app.use(timeout(500));
    app.get("/", (c) => c.text("ok"));
    const res = await fetchVia(app, "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("slow handlers get 408 and late responses cannot overwrite it", async () => {
    const app = new Mino();
    app.use(timeout(20));
    app.get("/", async (c) => {
      await sleep(60);
      return c.text("too-late");
    });
    const res = await fetchVia(app, "/");
    expect(res.status).toBe(408);
    expect(await res.json()).toMatchObject({ status: 408, code: "request_timeout" });
  });
});

describe("secure: request-id + logger", () => {
  it("generates, propagates valid incoming, regenerates hostile", async () => {
    const app = new Mino();
    app.use(requestId());
    app.get("/", (c) => c.text((c.get("requestId") as string) ?? ""));
    const gen = await fetchVia(app, "/");
    const id = gen.headers.get("x-request-id") ?? "";
    expect(id.length).toBeGreaterThan(8);
    expect(await gen.text()).toBe(id);

    const echo = await fetchVia(app, "/", { headers: { "x-request-id": "req-123" } });
    expect(echo.headers.get("x-request-id")).toBe("req-123");

    // Fetch/undici rejects CRLF header values at Request construction, so a
    // hostile ID can only arrive via a runtime adapter bypass — simulate with
    // a Request-shaped object carrying a raw header getter.
    const evilReq = {
      url: "http://localhost/",
      method: "GET",
      headers: { get: (n: string) => (n.toLowerCase() === "x-request-id" ? "a\r\nB: c" : null) },
    } as unknown as Request;
    const evil = await app.fetch(evilReq);
    const out = evil.headers.get("x-request-id") ?? "";
    expect(out).not.toContain("\r");
    expect(out).not.toBe("a\r\nB: c");
  });

  it("logger records method/path/status/ms without throwing", async () => {
    const seen: unknown[] = [];
    const app = new Mino();
    app.use(requestId(), logger({ log: (e) => seen.push(e) }));
    app.get("/things/:id", (c) => c.json({ id: c.param("id") }));
    await fetchVia(app, "/things/7");
    await fetchVia(app, "/missing");
    expect(seen.length).toBe(2);
    const first = seen[0] as {
      method: string;
      path: string;
      status: number;
      ms: number;
      route?: string;
    };
    expect(first).toMatchObject({
      method: "GET",
      path: "/things/7",
      status: 200,
      route: "/things/:id",
    });
    expect(typeof first.ms).toBe("number");
    expect((seen[1] as { status: number }).status).toBe(404);
  });

  it("logger skip keeps health checks quiet", async () => {
    const seen: unknown[] = [];
    const app = new Mino();
    app.use(logger({ log: (e) => seen.push(e), skip: (c) => (c as Context).path === "/health" }));
    app.get("/health", (c) => c.text("ok"));
    app.get("/real", (c) => c.text("ok"));
    await fetchVia(app, "/health");
    await fetchVia(app, "/real");
    expect(seen.length).toBe(1);
  });

  it("routes still work when logger middleware is present (spy sanity)", async () => {
    const spy = vi.fn();
    const app = new Mino();
    app.use(logger({ log: spy }));
    app.get("/", (c) => c.text("ok"));
    expect((await fetchVia(app, "/")).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
