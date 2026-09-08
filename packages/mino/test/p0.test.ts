import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { Router } from "../src/router.js";
import { Context } from "../src/context.js";
import { createClient } from "../src/client.js";
import { formatSSE } from "../src/sse.js";
import { validator } from "../src/validator.js";
import { m } from "@minostack/schema";

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("P0 fixes", () => {
  it("router decodeURIComponent throws 400 on malformed %ZZ", async () => {
    const app = new Mino();
    app.get("/users/:id", (c) => c.json(c.params));
    const res = await fetchVia(app, "/users/%2G");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid URL");
  });

  it("router wildcard decode malformed returns 400", async () => {
    const app = new Mino();
    app.get("/files/*", (c) => c.json((c.params as Record<string, string>).wildcard));
    const res = await fetchVia(app, "/files/%2G");
    expect(res.status).toBe(400);
  });

  it("router wildcard must be last segment", () => {
    const r = new Router();
    expect(() => r.add("GET", "/a/*/b", [(c: Context) => c.text("hi")])).toThrow(/must be last/);
  });

  it("prefix bypass /api should not match /api-test", async () => {
    const app = new Mino();
    let ran = false;
    app.use("/api", async (_c, next) => {
      ran = true;
      await next();
    });
    app.get("/api/test", (c) => c.text("api"));
    app.get("/api-test", (c) => c.text("api-test"));
    ran = false;
    const res1 = await fetchVia(app, "/api/test");
    expect(res1.status).toBe(200);
    expect(ran).toBe(true);
    ran = false;
    const res2 = await fetchVia(app, "/api-test");
    expect(await res2.text()).toBe("api-test");
    expect(ran).toBe(false);
  });

  it("HEAD strips content-length", async () => {
    const app = new Mino();
    app.get("/data", (c) => {
      c.headerSet("x-custom", "1");
      return c.json({ x: 1 });
    });
    const res = await fetchVia(app, "/data", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-length")).toBeNull();
    // GET still has content-length? Our HEAD removes it, GET should have it if set via json
    const get = await fetchVia(app, "/data", { method: "GET" });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ x: 1 });
  });

  it("405 returns Allow", async () => {
    const app = new Mino();
    app.get("/only-get", (c) => c.text("get"));
    const res = await fetchVia(app, "/only-get", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("strict mode distinguishes trailing slash", async () => {
    const strict = new Mino({ strict: true });
    strict.get("/foo", (c) => c.text("no slash"));
    strict.get("/foo/", (c) => c.text("slash"));
    expect(await (await fetchVia(strict, "/foo")).text()).toBe("no slash");
    expect(await (await fetchVia(strict, "/foo/")).text()).toBe("slash");
    expect((await fetchVia(strict, "/foo//")).status).toBe(404);

    const loose = new Mino({ strict: false });
    loose.get("/foo", (c) => c.text("ok"));
    expect((await fetchVia(loose, "/foo/")).status).toBe(200);
    expect((await fetchVia(loose, "/foo")).status).toBe(200);
  });

  it("validator does not consume body (clone+cache)", async () => {
    const User = m.object({ name: m.string() });
    const app = new Mino();
    app.post("/users", validator("json", User), async (c) => {
      const valid = c.valid<{ name: string }>("json");
      const raw = await c.jsonBody<{ name: string }>();
      return c.json({ valid, raw });
    });
    const res = await fetchVia(app, "/users", {
      method: "POST",
      body: JSON.stringify({ name: "hi" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: { name: string }; raw: { name: string } };
    expect(body.valid).toEqual({ name: "hi" });
    expect(body.raw).toEqual({ name: "hi" });

    // invalid json should be 400, and body not consumed for next? Test second request with invalid
    const bad = await fetchVia(app, "/users", {
      method: "POST",
      body: "not-json",
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(400);
  });

  it("client thenable not hanging", async () => {
    const app = new Mino();
    app.get("/hello", (c) => c.json({ hi: 1 }));
    const client = createClient("http://localhost", {
      fetch: (url, init) => app.fetch(new Request(url, init as RequestInit)) as Promise<Response>,
    });
    // awaiting client directly should not hang (then should be undefined)
    const maybe = (client as unknown as { then?: unknown }).then;
    expect(maybe).toBeUndefined();
    // Promise.resolve should not treat as thenable
    const resolved = await Promise.resolve(client as unknown as Promise<unknown>);
    expect(resolved).toBe(client);
    // (client as any).catch etc.
    expect((client as unknown as { catch?: unknown }).catch).toBeUndefined();
    expect((client as unknown as { finally?: unknown }).finally).toBeUndefined();
    // actual request still works
    const res = await (
      client as unknown as Record<string, { $get: () => Promise<Response> }>
    ).hello!.$get();
    expect(res.status).toBe(200);
  });

  it("client replaces all duplicate params", async () => {
    const app = new Mino();
    app.get("/a/:id/b/:id", (c) => c.json(c.params));
    const client = createClient("http://localhost", {
      fetch: (url) => {
        // capture url
        return app.fetch(new Request(url));
      },
    });
    // Use duplicate param name in pathParts: /a/:id/b/:id with param id=5 should replace both
    // Our buildUrl is internal, test via client proxy
    const proxy = (client as unknown as Record<string, unknown> & { a: Record<string, unknown> }).a[
      ":id"
    ] as unknown as Record<string, unknown> & { b: Record<string, unknown> };
    const proxy2 = (proxy as unknown as Record<string, unknown> & { b: Record<string, unknown> }).b[
      ":id"
    ] as unknown as {
      $get: (opts: { param: Record<string, string> }) => Promise<Response>;
    };
    const res = await proxy2.$get({ param: { id: "5" } });
    // both :id replaced => /a/5/b/5
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.id).toBe("5");
  });

  it("formatSSE handles retry 0", () => {
    expect(formatSSE({ data: "hi", retry: 0 })).toContain("retry: 0");
    expect(formatSSE({ data: "hi" })).not.toContain("retry:");
    expect(formatSSE({ data: "hi", retry: 10 })).toContain("retry: 10");
  });

  it("context body single allocation", async () => {
    const app = new Mino();
    app.post("/body", async (c) => {
      return c.body("hello", { status: 201, headers: { "x-test": "1" } });
    });
    const res = await fetchVia(app, "/body", { method: "POST", body: "x" });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("x-test")).toBe("1");
  });

  it("compose cross-realm Response detection still works", async () => {
    const app = new Mino();
    // Simulate cross-realm by using object that looks like Response but not instance
    const fakeResponse = {
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as Response;
    app.get("/", (c, _next) => {
      // return fake duck-typed response
      return fakeResponse as unknown as Response;
    });
    const res = await fetchVia(app, "/");
    expect(res.status).toBe(200);
  });

  it("validator handles ~standard and safeParse priority", async () => {
    // Zod-like dual schema: has both ~standard and safeParse, should prefer ~standard
    const dual: unknown = {
      "~standard": {
        validate(value: unknown) {
          if (
            typeof value === "object" &&
            value !== null &&
            "name" in (value as Record<string, unknown>)
          ) {
            return { value: { name: "from-standard" } };
          }
          return { issues: [{ message: "bad", path: [] }] };
        },
      },
      safeParse(_v: unknown) {
        return { success: true, data: { name: "from-safeParse" } };
      },
    };
    const app = new Mino();
    app.post("/test", validator("json", dual as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/test", {
      method: "POST",
      body: JSON.stringify({ name: "hi" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("from-standard");
  });
});
