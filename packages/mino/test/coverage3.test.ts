import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { Router } from "../src/router.js";
import { Context } from "../src/context.js";
import { compose } from "../src/compose.js";
import { validator } from "../src/validator.js";
import { m } from "@minostack/schema";

async function fetchVia(app: Mino, path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("additional coverage", () => {
  it("router static splitPath with strict vs loose", () => {
    const rStrict = new Router({ strict: true });
    rStrict.add("GET", "/a", [(c: Context) => c.text("a")]);
    rStrict.add("GET", "/a/", [(c: Context) => c.text("a slash")]);
    expect(rStrict.match("GET", "/a")?.routePath).toBe("/a");
    expect(rStrict.match("GET", "/a/")?.routePath).toBe("/a/");

    const rLoose = new Router({ strict: false });
    rLoose.add("GET", "/a", [(c: Context) => c.text("a")]);
    expect(rLoose.match("GET", "/a/")?.routePath).toBe("/a");
    expect(Router.splitPath("/a/b?x=1#h")).toEqual(["a", "b"]);
  });

  it("router allowedMethods for param and wildcard", async () => {
    const app = new Mino();
    app.get("/users/:id", (c) => c.text("get"));
    app.post("/users/:id", (c) => c.text("post"));
    const res = await fetchVia(app, "/users/1", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")!).toContain("GET");
    expect(res.headers.get("allow")!).toContain("POST");

    const app2 = new Mino();
    app2.get("/files/*", (c) => c.text("file"));
    expect((await fetchVia(app2, "/files/a", { method: "POST" })).status).toBe(405);
  });

  it("compose directly with multiple handlers and next", async () => {
    const order: string[] = [];
    const h1 = async (c: Context, next: () => Promise<void>) => {
      order.push("1");
      await next();
      order.push("1-after");
    };
    const h2 = async (c: Context, next: () => Promise<void>) => {
      order.push("2");
      await next();
    };
    const h3 = (c: Context) => {
      order.push("3");
      return c.text("done");
    };
    const fn = compose([h1 as never, h2 as never, h3 as never]);
    const res = await fn(new Context(new Request("http://localhost/")));
    expect(await res.text()).toBe("done");
    expect(order).toEqual(["1", "2", "3", "1-after"]);

    // test isResponse duck-type with cross-realm object
    const fake = {
      status: 201,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      body: null,
    } as unknown as Response;
    const fn2 = compose([(c: Context) => fake as unknown as Response]);
    const res2 = await fn2(new Context(new Request("http://localhost/")));
    expect(res2.status).toBe(201);
  });

  it("compose next called multiple times in same handler throws", async () => {
    const fn = compose([
      async (_c: Context, next: () => Promise<void>) => {
        await next();
        // second call in same handler should throw
        await expect(next()).rejects.toThrow(/multiple times/);
        return new Response("ok");
      },
      (c: Context) => c.text("second"),
    ]);
    const res = await fn(new Context(new Request("http://localhost/")));
    expect(res.status).toBe(200);
  });

  it("validator with header and query and form edge cases", async () => {
    const app = new Mino();
    // header validator with missing header
    const H = m.object({ "x-test": m.string() });
    app.get("/h2", validator("header", H), (c) => c.json(c.valid("header")));
    expect((await fetchVia(app, "/h2")).status).toBe(422);
    expect((await fetchVia(app, "/h2", { headers: { "x-test": "hi" } })).status).toBe(200);

    // query with array
    const Q = m.object({ q: m.string() });
    const appQ = new Mino();
    appQ.get("/q2", validator("query", Q), (c) => c.json(c.valid("query")));
    expect((await fetchVia(appQ, "/q2?q=a")).status).toBe(200);

    // form with missing field
    const F = m.object({ name: m.string().min(2) });
    const appF = new Mino();
    appF.post("/f2", validator("form", F), (c) => c.json(c.valid("form")));
    const fdGood = new FormData();
    fdGood.set("name", "hi");
    expect(
      (await appF.fetch(new Request("http://localhost/f2", { method: "POST", body: fdGood })))
        .status,
    ).toBe(200);
    const fdBad = new FormData();
    fdBad.set("name", "a");
    expect(
      (await appF.fetch(new Request("http://localhost/f2", { method: "POST", body: fdBad })))
        .status,
    ).toBe(422);
  });

  it("context helpers coverage", async () => {
    const app = new Mino();
    app.get("/c", (c) => {
      c.status(201);
      c.headerSet("x-a", "1");
      c.headerSet("x-b", "2");
      // test body with headers
      return c.body("hello", { headers: { "x-c": "3" } });
    });
    const res = await fetchVia(app, "/c");
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("1");
    expect(res.headers.get("x-b")).toBe("2");
    expect(res.headers.get("x-c")).toBe("3");

    app.get("/c2", (c) => {
      c.set("k", "v");
      expect(c.get("k")).toBe("v");
      expect(c.var("k")).toBe("v");
      expect(c.param()).toEqual({});
      expect(c.queryValue("missing")).toBeUndefined();
      expect(c.queries("missing")).toEqual([]);
      return c.text("ok");
    });
    await fetchVia(app, "/c2");

    app.get("/c3", async (c) => {
      c.json({ a: 1 });
      expect(c.res?.status).toBe(200);
      return c.res!;
    });
    await fetchVia(app, "/c3");
  });

  it("mino prefix and mount edge", async () => {
    const app = new Mino({ prefix: "/api/" });
    app.get("/users", (c) => c.text("users"));
    expect((await fetchVia(app, "/api/users")).status).toBe(200);
    expect((await fetchVia(app, "/api//users")).status).toBe(404);

    const sub = new Mino({ prefix: "/v1" });
    sub.get("/hi", (c) => c.text("hi"));
    const parent = new Mino();
    parent.mount("/api", sub);
    expect((await fetchVia(parent, "/api/v1/hi")).status).toBe(200);
  });

  it("validator with safeParse success and failure branches", async () => {
    const goodSchema = {
      safeParse(value: unknown) {
        if ((value as Record<string, unknown>).name === "ok") return { success: true, data: value };
        return { success: false, error: { issues: [{ message: "bad", path: [] }] } };
      },
    };
    const app = new Mino();
    app.post("/v", validator("json", goodSchema as never), (c) => c.json(c.valid("json")));
    const ok = await fetchVia(app, "/v", {
      method: "POST",
      body: JSON.stringify({ name: "ok" }),
      headers: { "content-type": "application/json" },
    });
    expect(ok.status).toBe(200);
    const bad = await fetchVia(app, "/v", {
      method: "POST",
      body: JSON.stringify({ name: "bad" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(422);

    const parseOnly = {
      parse(v: unknown) {
        if ((v as Record<string, unknown>).ok) return v;
        throw new Error("parse fail");
      },
    };
    const app2 = new Mino();
    app2.post("/p2", validator("json", parseOnly as never), (c) => c.json(c.valid("json")));
    expect(
      (
        await fetchVia(app2, "/p2", {
          method: "POST",
          body: JSON.stringify({ ok: true }),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetchVia(app2, "/p2", {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(422);
  });

  it("router handles duplicate GET concatenates", () => {
    const r = new Router();
    const h1 = (c: Context) => c.text("1");
    const h2 = (c: Context) => c.text("2");
    r.add("GET", "/dup", [h1]);
    r.add("GET", "/dup", [h2]);
    const m = r.match("GET", "/dup");
    expect(m?.handlers.length).toBe(2);
  });
});
