import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { Router } from "../src/router.js";
import { Context } from "../src/context.js";
import { validator } from "../src/validator.js";

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

// ─── B1: routing ─────────────────────────────────────────────────────────────
describe("hardening: routing", () => {
  it("encoded slash stays inside param value, does not re-split route", async () => {
    const app = new Mino();
    app.get("/u/:id", (c) => c.text(c.param("id") as string));
    app.get("/u/:id/profile", (c) => c.text(`profile:${c.param("id")}`));
    // %2F decodes to "/" in the VALUE but must not jump to the /profile route
    expect(await (await fetchVia(app, "/u/a%2Fb")).text()).toBe("a/b");
  });

  it("null byte, dot-dot, double encoding never escape or crash", async () => {
    const app = new Mino();
    app.get("/f/:x", (c) => c.text(`v:${c.param("x")}`));
    // WHATWG URL normalizes %2e segments away before fetch() sees them, so
    // /f/%2e%2e becomes / and 404s — that is correct, not a crash or escape.
    for (const p of ["/f/%00", "/f/%252F", "/f/hello%20world"]) {
      const res = await fetchVia(app, p);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/^v:/);
    }
    expect((await fetchVia(app, "/f/%2e%2e")).status).toBe(404);
  });

  it("invalid percent encodings are 400, not 500", async () => {
    const app = new Mino();
    app.get("/u/:id", (c) => c.text("ok"));
    for (const p of ["/u/%ZZ", "/u/%E0%A4%A", "/u/%C3%28"]) {
      expect((await fetchVia(app, p)).status).toBe(400);
    }
  });

  it("empty param segment and case sensitivity", async () => {
    const app = new Mino();
    app.get("/users/:id", (c) => c.text(c.param("id") as string));
    app.get("/Hello", (c) => c.text("cap"));
    expect((await fetchVia(app, "/users//books")).status).toBe(404);
    expect((await fetchVia(app, "/hello")).status).toBe(404);
    expect((await fetchVia(app, "/Hello")).status).toBe(200);
  });

  it("405 Allow lists all methods; fast-map and trie agree", async () => {
    const app = new Mino();
    app.get("/m", (c) => c.text("g"));
    app.post("/m", (c) => c.text("p"));
    const res = await fetchVia(app, "/m", { method: "DELETE" });
    expect(res.status).toBe(405);
    const allow = res.headers.get("allow") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
    // fast-static hit path also returns same routePath
    const r = app.getRouter();
    expect(r.match("GET", "/m")?.routePath).toBe("/m");
  });

  it("500-route table matches the right tail route", async () => {
    const app = new Mino();
    for (let i = 0; i < 500; i++) app.get(`/r${i}`, (c) => c.text(c.routePath ?? ""));
    const res = await fetchVia(app, "/r499");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/r499");
  });

  it("absurd paths are 414, deep-but-sane paths still route", async () => {
    const app = new Mino();
    app.get("/a/b/c", (c) => c.text("ok"));
    expect((await fetchVia(app, "/a/b/c")).status).toBe(200);
    expect((await fetchVia(app, `/${"x".repeat(3000)}`)).status).toBe(414);
    expect(
      (await fetchVia(app, `/${Array.from({ length: 200 }, (_, i) => `s${i}`).join("/")}`)).status,
    ).toBe(414);
  });
});

// ─── B2: middleware & pipeline ───────────────────────────────────────────────
describe("hardening: middleware & pipeline", () => {
  it("two apps do not share pipeline cache; methods are isolated", async () => {
    const a = new Mino();
    const b = new Mino();
    a.get("/x", (c) => c.text("A"));
    b.get("/x", (c) => c.text("B"));
    expect(await (await fetchVia(a, "/x")).text()).toBe("A");
    expect(await (await fetchVia(b, "/x")).text()).toBe("B");
    a.post("/x", (c) => c.text("A-post"));
    expect(await (await fetchVia(a, "/x", { method: "POST" })).text()).toBe("A-post");
    expect((await fetchVia(b, "/x", { method: "POST" })).status).toBe(405);
  });

  it("global middleware runs on 404 and 405", async () => {
    const app = new Mino();
    let hits = 0;
    app.use(async (_c, next) => {
      hits++;
      await next();
    });
    app.get("/ok", (c) => c.text("ok"));
    await fetchVia(app, "/missing");
    await fetchVia(app, "/ok", { method: "POST" });
    expect(hits).toBe(2);
  });

  it("async middleware with timer preserves order", async () => {
    const app = new Mino();
    const order: string[] = [];
    app.use(async (_c, next) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("mw");
      await next();
    });
    app.get("/", (c) => {
      order.push("h");
      return c.text("ok");
    });
    await fetchVia(app, "/");
    expect(order).toEqual(["mw", "h"]);
  });

  it("404 cache stays bounded under attacker path spray", async () => {
    const app = new Mino();
    app.get("/real", (c) => c.text("ok"));
    for (let i = 0; i < 1500; i++) {
      const res = await fetchVia(app, `/nope-${i}`);
      expect(res.status).toBe(404);
    }
    const size = (app as unknown as { pipelineCache: Map<string, unknown> }).pipelineCache.size;
    expect(size).toBeLessThanOrEqual(1024);
    expect((await fetchVia(app, "/real")).status).toBe(200);
  });
});

// ─── B3: context & responses ─────────────────────────────────────────────────
describe("hardening: context & responses", () => {
  it("non-Response handler return becomes generic 500, not a leak", async () => {
    const app = new Mino();
    app.get("/s", (() => "oops") as unknown as (c: Context) => Response);
    const res = await fetchVia(app, "/s");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("Internal Server Error");
    expect(body).not.toContain("oops");
  });

  it("handler returning undefined with no chain is 404", async () => {
    const app = new Mino();
    app.get("/u", (() => undefined) as unknown as (c: Context) => Response);
    expect((await fetchVia(app, "/u")).status).toBe(404);
  });

  it("CRLF header injection becomes 500, connection intact", async () => {
    const app = new Mino();
    app.get("/h", (c) => c.headerSet("x-evil", "a\r\nB: b").text("x"));
    const res = await fetchVia(app, "/h");
    expect(res.status).toBe(500);
    // server still serves the next request
    expect((await fetchVia(app, "/h")).status).toBe(500);
  });

  it("8KB header and 500-item JSON round-trip", async () => {
    const app = new Mino();
    app.get("/big-h", (c) => c.text(c.header("x-big") ?? ""));
    app.post("/big", async (c) => c.json(await c.jsonBody()));
    const bigVal = "v".repeat(8000);
    const r1 = await fetchVia(app, "/big-h", { headers: { "x-big": bigVal } });
    expect(await r1.text()).toBe(bigVal);
    const big = { arr: Array.from({ length: 500 }, (_, i) => ({ i })) };
    const r2 = await fetchVia(app, "/big", {
      method: "POST",
      body: JSON.stringify(big),
      headers: { "content-type": "application/json" },
    });
    expect(await r2.json()).toEqual(big);
  });

  it("validator then jsonBody reuses cache (no bodyUsed)", async () => {
    const { m } = await import("@minostack/schema");
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/v", validator("json", S as never), async (c) => {
      const again = await c.jsonBody<{ a: string }>();
      return c.json(again);
    });
    const res = await fetchVia(app, "/v", {
      method: "POST",
      body: JSON.stringify({ a: "x" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: "x" });
  });
});

// ─── B4: errors & security ───────────────────────────────────────────────────
describe("hardening: errors & security", () => {
  it("5xx hides message+code; 4xx exposes code", async () => {
    const { HttpError } = await import("../src/errors.js");
    const app = new Mino();
    app.get("/e5", () => {
      throw new HttpError(500, "secret-db-down", { code: "db_down" });
    });
    app.get("/e4", () => {
      throw new HttpError(403, "nope", { code: "forbidden_x" });
    });
    const r5 = await fetchVia(app, "/e5");
    const t5 = await r5.text();
    expect(r5.status).toBe(500);
    expect(t5).not.toContain("secret-db-down");
    expect(t5).not.toContain("db_down");
    const r4 = await fetchVia(app, "/e4");
    expect(await r4.json()).toMatchObject({ status: 403, code: "forbidden_x" });
  });

  it("generic Error never leaks message/stack/host", async () => {
    const app = new Mino();
    app.get("/boom", () => {
      throw new Error("sql at 10.0.0.5:5432\n    at secretFunc (/app/db.ts:1:1)");
    });
    const res = await fetchVia(app, "/boom");
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).not.toContain("10.0.0.5");
    expect(body).not.toContain("secretFunc");
    expect(body).not.toContain("sql at");
  });

  it("invalid JSON is 400; schema failure is 422 with bounded issues", async () => {
    const { m } = await import("@minostack/schema");
    const S = m.object({ name: m.string().min(2) });
    const app = new Mino();
    app.post("/u", validator("json", S as never), (c) => c.text("ok"));
    const bad = await fetchVia(app, "/u", {
      method: "POST",
      body: "{not-json",
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
    const fail = await fetchVia(app, "/u", {
      method: "POST",
      body: JSON.stringify({ name: "a" }),
      headers: { "content-type": "application/json" },
    });
    expect(fail.status).toBe(422);
    // issues cap: object missing 60 required fields → at most 50 reported
    const fields: Record<string, ReturnType<typeof m.string>> = {};
    for (let i = 0; i < 60; i++) fields[`f${i}`] = m.string();
    const Big = m.object(fields);
    const app2 = new Mino();
    app2.post("/big", validator("json", Big as never), (c) => c.text("ok"));
    const capped = await fetchVia(app2, "/big", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(capped.status).toBe(422);
    const j = (await capped.json()) as { issues: unknown[] };
    expect(j.issues.length).toBeLessThanOrEqual(50);
  });

  it("async schema fails closed with 500, no promise leak", async () => {
    const app = new Mino();
    const asyncSchema = {
      "~standard": {
        validate: async (_v: unknown) => ({ value: _v }),
      },
    };
    app.post("/a", validator("json", asyncSchema as never), (c) => c.text("unreached"));
    const res = await fetchVia(app, "/a", {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("unreached");
  });

  it("garbage schema object fails closed, process stays up", async () => {
    const app = new Mino();
    app.post("/g", validator("json", {} as never), (c) => c.text("unreached"));
    const res = await fetchVia(app, "/g", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
    expect(
      (
        await fetchVia(app, "/g", {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(500);
  });

  it("malformed authorities are 400 (fake Request bypasses URL ctor)", async () => {
    const app = new Mino();
    app.get("/", (c) => c.text("ok"));
    // new Request() itself throws on these, so exercise fetch() with fake
    // Request-shaped objects the way runtime adapters might.
    const fake = (url: string) =>
      ({ url, method: "GET", headers: new Headers() }) as unknown as Request;
    for (const url of [
      "http://%",
      "http://exa mple/",
      "http://a\\b/",
      "http://user@/x",
      "http://[::1/x",
      "http:///x",
    ]) {
      expect((await app.fetch(fake(url))).status).toBe(400);
    }
  });

  it("unsupported method and prefix boundary", async () => {
    const app = new Mino({ prefix: "/api" });
    app.get("/u", (c) => c.text("u"));
    expect((await fetchVia(app, "/api/u")).status).toBe(200);
    expect((await fetchVia(app, "/api-users")).status).toBe(404);
    expect(
      (await app.fetch(new Request("http://localhost/api/u", { method: "PURGE" }))).status,
    ).toBe(405);
  });
});

// ─── B5: concurrency & isolation ─────────────────────────────────────────────
describe("hardening: concurrency & isolation", () => {
  it("200 parallel distinct params stay isolated", async () => {
    const app = new Mino();
    app.get("/u/:id", (c) => {
      c.set("id", c.param("id"));
      return c.json({ id: c.get("id") });
    });
    const out = await Promise.all(
      Array.from({ length: 200 }, (_, i) => fetchVia(app, `/u/${i}`).then((r) => r.json())),
    );
    out.forEach((r: unknown, i: number) => expect(r).toEqual({ id: String(i) }));
  });

  it("mutating c.params does not leak to next request", async () => {
    const app = new Mino();
    app.get("/a/:x", (c) => {
      const p = c.params as Record<string, string>;
      const cur = p["x"];
      p["x"] = "polluted";
      return c.text(cur as string);
    });
    expect(await (await fetchVia(app, "/a/1")).text()).toBe("1");
    expect(await (await fetchVia(app, "/a/2")).text()).toBe("2");
  });

  it("pipeline cache hit 1000x stable, size bounded", async () => {
    const app = new Mino();
    app.get("/s", (c) => c.text("ok"));
    for (let i = 0; i < 1000; i++) {
      expect((await fetchVia(app, "/s")).status).toBe(200);
    }
    const size = (app as unknown as { pipelineCache: Map<string, unknown> }).pipelineCache.size;
    expect(size).toBeLessThanOrEqual(8);
  });
});
