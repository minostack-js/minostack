import { describe, it, expect } from "vitest";
import { Mino, type MinoOptions } from "../src/mino.js";
import { validator } from "../src/validator.js";
import { DEFAULT_LIMITS } from "../src/context.js";
import { m } from "@minostack/schema";

const KB = 1024;

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

function jsonApp(limits?: MinoOptions) {
  const app = new Mino(limits ?? {});
  const S = m.object({ name: m.string() });
  app.post("/u", validator("json", S as never), (c) => c.text("ok"));
  return app;
}

describe("limits: JSON body cap (A1)", () => {
  it("defaults to 100kb like Express", () => {
    expect(DEFAULT_LIMITS.json).toBe(100 * KB);
    expect(DEFAULT_LIMITS.text).toBe(100 * KB);
    expect(DEFAULT_LIMITS.form).toBe(100 * KB);
  });

  it("99kb and exactly 100kb pass", async () => {
    const app = jsonApp();
    for (const size of [99 * KB, 100 * KB]) {
      const body = JSON.stringify({ name: "x".repeat(size - 20) });
      const res = await fetchVia(app, "/u", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
    }
  });

  it("101kb returns 413 with machine-readable shape", async () => {
    const app = jsonApp();
    const body = JSON.stringify({ name: "x".repeat(101 * KB) });
    const res = await fetchVia(app, "/u", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      status: 413,
      code: "payload_too_large",
    });
  });

  it("per-route validator limit override shrinks and grows the cap", async () => {
    const S = m.object({ name: m.string() });
    const strict = new Mino();
    strict.post("/s", validator("json", S as never, { limit: 64 }), (c) => c.text("ok"));
    const roomy = new Mino();
    roomy.post("/r", validator("json", S as never, { limit: 300 * KB }), (c) => c.text("ok"));

    const small = JSON.stringify({ name: "x".repeat(100) });
    expect(
      (
        await fetchVia(strict, "/s", {
          method: "POST",
          body: small,
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(413);

    const big = JSON.stringify({ name: "x".repeat(200 * KB) });
    const res = await fetchVia(roomy, "/r", {
      method: "POST",
      body: big,
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
  });

  it("app-level limits option shrinks the cap", async () => {
    const app = new Mino({ limits: { json: 64 } });
    const S = m.object({ name: m.string() });
    app.post("/u", validator("json", S as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/u", {
      method: "POST",
      body: JSON.stringify({ name: "x".repeat(100) }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(413);
  });

  it("context body helpers enforce app limits directly", async () => {
    const app = new Mino({ limits: { text: 16, json: 16 } });
    app.post("/t", async (c) => c.text(await c.textBody()));
    app.post("/j", async (c) => c.json(await c.jsonBody()));
    expect((await fetchVia(app, "/t", { method: "POST", body: "x".repeat(32) })).status).toBe(413);
    expect(
      (
        await fetchVia(app, "/j", {
          method: "POST",
          body: JSON.stringify({ a: "x".repeat(64) }),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(413);
  });
});

describe("limits: query and header bounds (A2)", () => {
  it("101 query keys return 400", async () => {
    const app = new Mino();
    app.get("/q", (c) => c.json(c.query));
    const qs = Array.from({ length: 101 }, (_, i) => `k${i}=v`).join("&");
    expect((await fetchVia(app, `/q?${qs}`)).status).toBe(400);
  });

  it("100 query keys still pass", async () => {
    const app = new Mino();
    app.get("/q", (c) => c.json(c.query));
    const qs = Array.from({ length: 100 }, (_, i) => `k${i}=v`).join("&");
    expect((await fetchVia(app, `/q?${qs}`)).status).toBe(200);
  });

  it("oversize query value returns 400", async () => {
    const app = new Mino();
    app.get("/q", (c) => c.text(c.query["k"] ?? ""));
    expect((await fetchVia(app, `/q?k=${"v".repeat(9000)}`)).status).toBe(400);
  });

  it("101 headers return 400 via validator header target", async () => {
    const S = m.object({}).passthrough();
    const app = new Mino();
    app.get("/h", validator("header", S as never), (c) => c.text("ok"));
    const headers: Record<string, string> = {};
    for (let i = 0; i < 101; i++) headers[`x-h-${i}`] = "v";
    expect((await fetchVia(app, "/h", { headers })).status).toBe(400);
  });

  it("oversize header value returns 400 via validator header target", async () => {
    const S = m.object({}).passthrough();
    const app = new Mino();
    app.get("/h", validator("header", S as never), (c) => c.text("ok"));
    expect((await fetchVia(app, "/h", { headers: { "x-big": "v".repeat(9000) } })).status).toBe(
      400,
    );
  });

  it("101 form fields return 413", async () => {
    const S = m.object({}).passthrough();
    const app = new Mino();
    app.post("/f", validator("form", S as never), (c) => c.text("ok"));
    const fd = new FormData();
    for (let i = 0; i < 101; i++) fd.set(`f${i}`, "v");
    expect(
      (await app.fetch(new Request("http://localhost/f", { method: "POST", body: fd }))).status,
    ).toBe(413);
  });
});

describe("limits: error hygiene (A3/A4)", () => {
  it("router 400 body is fixed, never echoes segments", async () => {
    const app = new Mino();
    app.get("/u/:id", (c) => c.text("ok"));
    const res = await fetchVia(app, "/u/%ZZ-evil-segment");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("evil-segment");
    // Router throws fixed "Invalid URL encoding"; the fallback path uses fixed
    // "Bad Request" — either way the body must never echo the segment bytes.
    expect(JSON.parse(body)).toMatchObject({ status: 400 });
  });

  it("overlong issue strings are truncated to 500 chars", async () => {
    const evil = {
      safeParse: () => ({
        success: false as const,
        error: { issues: [{ message: "x".repeat(2000), received: "y".repeat(2000) }] },
      }),
    };
    const app = new Mino();
    app.post("/u", validator("json", evil as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/u", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body.length).toBeLessThan(2000);
    const j = JSON.parse(body) as { issues: Array<{ message: string; received: string }> };
    expect(j.issues[0]?.message.length).toBeLessThanOrEqual(500);
    expect(j.issues[0]?.received.length).toBeLessThanOrEqual(500);
  });
});
