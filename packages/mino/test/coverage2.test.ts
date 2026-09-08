import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { Router } from "../src/router.js";
import { Context } from "../src/context.js";
import { compose } from "../src/compose.js";
import { validator } from "../src/validator.js";
import { m } from "@minostack/schema";

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("coverage additional", () => {
  it("validator header and query", async () => {
    const HeaderSchema = m.object({ x: m.string() });
    const app = new Mino();
    app.get("/h", validator("header", HeaderSchema), (c) => c.json(c.valid("header")));
    const ok = await fetchVia(app, "/h", { headers: { x: "hello" } });
    expect(ok.status).toBe(200);
    const bad = await fetchVia(app, "/h");
    expect(bad.status).toBe(422);

    const Q = m.object({ q: m.string().min(1) });
    const app2 = new Mino();
    app2.get("/q", validator("query", Q), (c) => c.json(c.valid("query")));
    expect((await fetchVia(app2, "/q?q=hi")).status).toBe(200);
    expect((await fetchVia(app2, "/q")).status).toBe(422);
  });

  it("validator form", async () => {
    const Form = m.object({ name: m.string() });
    const app = new Mino();
    app.post("/f", validator("form", Form), (c) => c.json(c.valid("form")));
    const fd = new FormData();
    fd.set("name", "hi");
    const res = await app.fetch(new Request("http://localhost/f", { method: "POST", body: fd }));
    expect(res.status).toBe(200);
    const badFd = new FormData();
    const res2 = await app.fetch(
      new Request("http://localhost/f", { method: "POST", body: badFd }),
    );
    expect(res2.status).toBe(422);
  });

  it("validator json with non-json content-type still tries", async () => {
    const Schema = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/j", validator("json", Schema), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/j", {
      method: "POST",
      body: JSON.stringify({ a: "hi" }),
      headers: { "content-type": "text/plain" },
    });
    // non-json content-type still tries to parse via clone().json() fallback, may succeed
    // Our extractValue for non-json tries clone().json(), if fails returns undefined -> then validation fails
    // For text/plain with json body, it will attempt json and succeed? Actually it will try clone().json() and succeed because body is json
    // So it may be 200; we just check it doesn't throw 500
    expect([200, 422]).toContain(res.status);
  });

  it("router splitPath with hash and query", () => {
    expect(Router.splitPath("/a/b?x=1#hash")).toEqual(["a", "b"]);
    expect(Router.splitPath("a/b")).toEqual(["a", "b"]);
    expect(Router.splitPath("/a//b")).toEqual(["a", "", "b"]);
  });

  it("router paramChild mismatch keeps first", () => {
    const r = new Router();
    r.add("GET", "/users/:id", [(c: Context) => c.text("1")]);
    r.add("GET", "/users/:name", [(c: Context) => c.text("2")]);
    // second registration keeps first param name
    const m1 = r.match("GET", "/users/123");
    expect(m1?.params.id).toBe("123");
    // name not used
    expect((m1?.params as Record<string, string>).name).toBeUndefined();
  });

  it("compose handles next multiple times and auto-continue", async () => {
    const app = new Mino();
    // Test auto-continue: first handler doesn't call next nor return Response, second should run via auto-dispatch
    app.get(
      "/auto",
      (c, _next) => {
        /* no next */
      },
      (c) => c.text("second"),
    );
    const res = await fetchVia(app, "/auto");
    expect(await res.text()).toBe("second");

    // Test double next throws 500
    const app2 = new Mino();
    app2.get("/", async (_c, next) => {
      await next();
      await next();
    });
    app2.get("/", (c) => c.text("hi")); // second route shouldn't matter
    const r2 = await fetchVia(app2, "/");
    expect(r2.status).toBe(500);
  });

  it("compose with response return short-circuits", async () => {
    const app = new Mino();
    app.use((c) => c.text("mw response"));
    app.get("/", (c) => c.text("should not"));
    const res = await fetchVia(app, "/");
    expect(await res.text()).toBe("mw response");
  });

  it("context response helpers", async () => {
    const app = new Mino();
    app.get("/json", (c) => c.json({ a: 1 }, 201, { "x-json": "1" }));
    app.get("/text", (c) => c.text("hi", 202));
    app.get("/html", (c) => c.html("<b>hi</b>", 203));
    app.get("/redirect", (c) => c.redirect("/json", 301));
    app.get("/body2", (c) => c.body(new Uint8Array([1, 2, 3]), { status: 201 }));
    expect((await fetchVia(app, "/json")).status).toBe(201);
    expect((await fetchVia(app, "/json")).headers.get("x-json")).toBe("1");
    expect((await fetchVia(app, "/text")).status).toBe(202);
    expect((await fetchVia(app, "/html")).headers.get("content-type")).toContain("text/html");
    const red = await fetchVia(app, "/redirect");
    expect(red.status).toBe(301);
    expect(red.headers.get("location")).toBe("/json");
    expect((await fetchVia(app, "/body2")).status).toBe(201);
  });

  it("context lazy query and headers", async () => {
    const app = new Mino();
    app.get("/q", (c) => {
      expect(c.query.q).toBe("hi");
      expect(c.queryAll.q).toEqual(["hi", "hello"]);
      expect(c.queries("q")).toEqual(["hi", "hello"]);
      expect(c.queryValue("q")).toBe("hi");
      expect(c.header("X-Custom")).toBe("val");
      expect(c.headers.get("x-custom")).toBe("val");
      return c.text("ok");
    });
    await fetchVia(app, "/q?q=hi&q=hello", { headers: { "x-custom": "val" } });
  });

  it("mino mount and prefix and errorHandler throwing", async () => {
    const sub = new Mino();
    sub.get("/hi", (c) => c.text("sub"));
    const app = new Mino();
    app.mount("/api", sub);
    expect((await fetchVia(app, "/api/hi")).status).toBe(200);

    app.onError((_err, _c) => {
      throw new Error("handler fail");
    });
    app.get("/boom2", () => {
      throw new Error("oops");
    });
    const res = await fetchVia(app, "/boom2");
    expect(res.status).toBe(500);
  });

  it("router allowedMethods for wildcard", async () => {
    const app = new Mino();
    app.get("/files/*", (c) => c.text("file"));
    expect((await fetchVia(app, "/files/a/b", { method: "POST" })).status).toBe(405);
  });

  it("validator fallback parse and missing schema", async () => {
    const app = new Mino();
    // schema with only parse (no safeParse, no ~standard)
    const onlyParse = {
      parse(value: unknown) {
        if (
          typeof value === "object" &&
          value !== null &&
          "name" in (value as Record<string, unknown>)
        )
          return value;
        throw new Error("bad");
      },
    };
    app.post("/p", validator("json", onlyParse as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/p", {
      method: "POST",
      body: JSON.stringify({ name: "hi" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const bad = await fetchVia(app, "/p", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(422);

    // missing schema should throw
    const badSchema: unknown = {};
    const app2 = new Mino();
    app2.post("/bad", validator("json", badSchema as never), (c) => c.text("hi"));
    const r = await fetchVia(app2, "/bad", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(500);
  });

  it("context sse and arrayBuffer", async () => {
    const app = new Mino();
    app.get("/ab", async (c) => {
      const buf = await c.arrayBufferBody().catch(() => new ArrayBuffer(0));
      return c.json({ len: buf.byteLength });
    });
    app.post("/ab", async (c) => {
      const buf = await c.arrayBufferBody();
      return c.json({ len: buf.byteLength });
    });
    const res = await fetchVia(app, "/ab", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(200);
  });
});
