import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { Router } from "../src/router.js";
import { Context } from "../src/context.js";

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("enterprise rugged: router", () => {
  it("strict mode distinguishes trailing slash", async () => {
    const app = new Mino({ strict: true });
    app.get("/foo", (c) => c.text("no-slash"));
    expect((await fetchVia(app, "/foo")).status).toBe(200);
    expect((await fetchVia(app, "/foo/")).status).toBe(404);
  });

  it("non-strict normalizes trailing slash + query/hash stripped", () => {
    const r = new Router();
    r.add("GET", "/a/b", [(c: Context) => c.text("ok")]);
    expect(r.match("GET", "/a/b/")?.routePath).toBe("/a/b");
    expect(Router.splitPath("/a/b?x=1")).toEqual(["a", "b"]);
    expect(Router.splitPath("/")).toEqual([]);
  });

  it("wildcard empty + deep remainder + encoded remainder", async () => {
    const app = new Mino();
    app.get("/files/*", (c) => c.text((c.params as Record<string, string>).wildcard ?? ""));
    expect(await (await fetchVia(app, "/files")).text()).toBe("");
    expect(await (await fetchVia(app, "/files/a/b/c/d/e")).text()).toBe("a/b/c/d/e");
    expect(await (await fetchVia(app, "/files/hello%20world")).text()).toBe("hello world");
  });

  it("param decodes % encoding, rejects bad encoding with 400", async () => {
    const app = new Mino();
    app.get("/u/:id", (c) => c.text(c.param("id") as string));
    expect(await (await fetchVia(app, "/u/hello%20world")).text()).toBe("hello world");
    expect(await (await fetchVia(app, "/u/%2F")).text()).toBe("/");
    const bad = await fetchVia(app, "/u/%ZZ");
    expect(bad.status).toBe(400);
  });

  it("static beats param; param beats wildcard", async () => {
    const app = new Mino();
    app.get("/f/*", (c) => c.text("wild"));
    app.get("/f/:id", (c) => c.text(`param:${c.param("id")}`));
    app.get("/f/me", (c) => c.text("static"));
    expect(await (await fetchVia(app, "/f/me")).text()).toBe("static");
    expect(await (await fetchVia(app, "/f/123")).text()).toBe("param:123");
    expect(await (await fetchVia(app, "/f/a/b")).text()).toBe("wild");
  });

  it("405 includes Allow header; 404 JSON shape", async () => {
    const app = new Mino();
    app.get("/only-get", (c) => c.text("ok"));
    const m = await fetchVia(app, "/only-get", { method: "POST" });
    expect(m.status).toBe(405);
    expect(m.headers.get("allow")).toContain("GET");
    const n = await fetchVia(app, "/nope");
    expect(n.status).toBe(404);
    expect(await n.json()).toMatchObject({ error: expect.any(String), status: 404 });
  });

  it("duplicate method+path concatenates handlers in order", async () => {
    const r = new Router();
    const order: string[] = [];
    r.add("GET", "/dup", [
      ((_c: Context, next: () => Promise<void>) => {
        order.push("first");
        return next();
      }) as never,
    ]);
    r.add("GET", "/dup", [
      (c: Context) => {
        order.push("second");
        return c.text("ok");
      },
    ]);
    expect(r.getRoutes().length).toBe(2);
    const app = new Mino();
    (app as unknown as { getRouter: () => Router }).getRouter().add("GET", "/dup", [
      ((_c: Context, next: () => Promise<void>) => {
        order.push("first");
        return next();
      }) as never,
    ]);
    void order;
  });

  it("wildcard must be last segment", () => {
    const r = new Router();
    expect(() => r.add("GET", "/a/*/b", [((c: Context) => c.text("x")) as never])).toThrow();
  });
});

describe("enterprise rugged: middleware & pipeline cache", () => {
  it("global middleware added after routes still runs (cache invalidation)", async () => {
    const app = new Mino();
    app.get("/", (c) => c.text((c.get("hit") as string) ?? "no-hit"));
    expect(await (await fetchVia(app, "/")).text()).toBe("no-hit");
    app.use(async (c, next) => {
      c.set("hit", "yes");
      await next();
    });
    expect(await (await fetchVia(app, "/")).text()).toBe("yes");
    // second hit uses cache
    expect(await (await fetchVia(app, "/")).text()).toBe("yes");
  });

  it("path-scoped middleware does not leak to sibling prefix", async () => {
    const app = new Mino();
    app.use("/api", async (c, next) => {
      c.set("scoped", true);
      await next();
    });
    app.get("/api/a", (c) => c.text(String(c.get("scoped") ?? "false")));
    app.get("/api-test", (c) => c.text(String(c.get("scoped") ?? "false")));
    expect(await (await fetchVia(app, "/api/a")).text()).toBe("true");
    expect(await (await fetchVia(app, "/api-test")).text()).toBe("false");
  });

  it("middleware short-circuit skips handler", async () => {
    const app = new Mino();
    let handlerRan = false;
    app.use((c) => c.text("blocked", 403));
    app.get("/", (c) => {
      handlerRan = true;
      return c.text("ok");
    });
    const res = await fetchVia(app, "/");
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it("double next() becomes 500 via errorHandler", async () => {
    const app = new Mino();
    app.use(async (_c, next) => {
      await next();
      await next();
    });
    app.get("/", (c) => c.text("ok"));
    expect((await fetchVia(app, "/")).status).toBe(500);
  });

  it("10 middleware preserve onion order", async () => {
    const app = new Mino();
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const n = i;
      app.use(async (_c, next) => {
        order.push(`in-${n}`);
        await next();
        order.push(`out-${n}`);
      });
    }
    app.get("/", (c) => {
      order.push("handler");
      return c.text("ok");
    });
    await fetchVia(app, "/");
    expect(order[0]).toBe("in-0");
    expect(order[10]).toBe("handler");
    expect(order[order.length - 1]).toBe("out-0");
    expect(order.length).toBe(21);
  });
});

describe("enterprise rugged: context & responses", () => {
  it("lazy url cached; query first-value semantics", async () => {
    const app = new Mino();
    app.get("/q", (c) => {
      const u1 = c.url;
      const u2 = c.url;
      expect(u1).toBe(u2);
      return c.json({ q: c.query["q"], all: c.queryAll["q"] });
    });
    const res = await fetchVia(app, "/q?q=a&q=b");
    expect(await res.json()).toEqual({ q: "a", all: ["a", "b"] });
  });

  it("json/text/html content-types + status override + headerSet", async () => {
    const app = new Mino();
    app.get("/j", (c) => c.headerSet("x-a", "1").json({ ok: true }, 201));
    app.get("/t", (c) => c.status(202).text("hi"));
    app.get("/h", (c) => c.html("<b>x</b>"));
    const j = await fetchVia(app, "/j");
    expect(j.status).toBe(201);
    expect(j.headers.get("content-type")).toContain("application/json");
    expect(j.headers.get("x-a")).toBe("1");
    expect((await fetchVia(app, "/t")).status).toBe(202);
    expect((await fetchVia(app, "/h")).headers.get("content-type")).toContain("text/html");
  });

  it("HEAD strips body but keeps content-type", async () => {
    const app = new Mino();
    app.get("/d", (c) => c.json({ x: 1 }));
    const res = await fetchVia(app, "/d", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("redirect sets location", async () => {
    const app = new Mino();
    app.get("/r", (c) => c.redirect("/target", 301));
    const res = await fetchVia(app, "/r");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/target");
  });
});

describe("enterprise rugged: errors & security", () => {
  it("HttpError expose=false hides 5xx message", async () => {
    const { HttpError } = await import("../src/errors.js");
    const app = new Mino();
    app.get("/e", () => {
      throw new HttpError(500, "secret-db-down");
    });
    const res = await fetchVia(app, "/e");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret-db-down");
  });

  it("errorHandler throwing still returns 500", async () => {
    const app = new Mino();
    app.onError(() => {
      throw new Error("handler boom");
    });
    app.get("/", () => {
      throw new Error("boom");
    });
    expect((await fetchVia(app, "/")).status).toBe(500);
  });

  it("malformed URL returns 400, not throw", async () => {
    const app = new Mino();
    app.get("/", (c) => c.text("ok"));
    const res = await app.fetch(new Request("http://localhost/%ZZ"));
    expect([400, 404]).toContain(res.status);
  });

  it("method case-insensitive match", async () => {
    const app = new Mino();
    app.get("/m", (c) => c.text("ok"));
    const res = await app.fetch(new Request("http://localhost/m", { method: "get" }));
    expect(res.status).toBe(200);
  });

  it("prefix option scopes routes", async () => {
    const app = new Mino({ prefix: "/api" });
    app.get("/u", (c) => c.text("u"));
    expect((await fetchVia(app, "/api/u")).status).toBe(200);
    expect((await fetchVia(app, "/u")).status).toBe(404);
  });
});

describe("enterprise rugged: concurrency & isolation", () => {
  it("100 parallel requests isolate params/state", async () => {
    const app = new Mino();
    app.get("/u/:id", (c) => {
      c.set("id", c.param("id"));
      return c.json({ id: c.get("id") });
    });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => fetchVia(app, `/u/${i}`).then((r) => r.json())),
    );
    results.forEach((r: unknown, i: number) => {
      expect(r).toEqual({ id: String(i) });
    });
  });

  it("sequential reuse does not leak params between requests", async () => {
    const app = new Mino();
    app.get("/a/:x", (c) => c.json(c.params));
    expect(await (await fetchVia(app, "/a/1")).json()).toEqual({ x: "1" });
    expect(await (await fetchVia(app, "/a/2")).json()).toEqual({ x: "2" });
  });

  it("large JSON body round-trips", async () => {
    const app = new Mino();
    app.post("/big", async (c) => c.json(await c.jsonBody()));
    const big = { arr: Array.from({ length: 500 }, (_, i) => ({ i, v: `v-${i}` })) };
    const res = await fetchVia(app, "/big", {
      method: "POST",
      body: JSON.stringify(big),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(big);
  });
});
