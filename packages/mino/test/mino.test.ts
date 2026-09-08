import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { Context } from "../src/context.js";
import { Router } from "../src/router.js";
import { compose } from "../src/compose.js";
import { HttpError, BadRequestError, NotFoundError, ValidationError } from "../src/errors.js";
import { validator } from "../src/validator.js";
import { createClient, hc } from "../src/client.js";
import { formatSSE, createSSEStream } from "../src/sse.js";
import { defineRoute, describeRoute, withContract, getContract } from "../src/contract.js";
import { m } from "@minostack/schema";

// Helper to fetch via Mino
async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  const url = `http://localhost${path}`;
  return app.fetch(new Request(url, init));
}

describe("Mino core", () => {
  it("handles static GET", async () => {
    const app = new Mino();
    app.get("/", (c) => c.text("hello"));
    const res = await fetchVia(app, "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("extracts params", async () => {
    const app = new Mino();
    app.get("/users/:id", (c) => c.json({ id: c.param("id"), all: c.params }));
    const res = await fetchVia(app, "/users/42");
    expect(await res.json()).toEqual({ id: "42", all: { id: "42" } });
  });

  it("handles multiple params", async () => {
    const app = new Mino();
    app.get("/users/:id/books/:bookId", (c) => c.json(c.params));
    const res = await fetchVia(app, "/users/1/books/99");
    expect(await res.json()).toEqual({ id: "1", bookId: "99" });
  });

  it("wildcard matches remainder", async () => {
    const app = new Mino();
    app.get("/files/*", (c) => c.json({ w: (c.params as Record<string, string>).wildcard }));
    const res = await fetchVia(app, "/files/a/b/c");
    expect(await res.json()).toEqual({ w: "a/b/c" });
    const res2 = await fetchVia(app, "/files");
    expect(await res2.json()).toEqual({ w: "" });
  });

  it("prioritizes static over param", async () => {
    const app = new Mino();
    app.get("/users/me", (c) => c.text("me"));
    app.get("/users/:id", (c) => c.text(c.param("id") as string));
    expect(await (await fetchVia(app, "/users/me")).text()).toBe("me");
    expect(await (await fetchVia(app, "/users/123")).text()).toBe("123");
  });

  it("handles query and headers", async () => {
    const app = new Mino();
    app.get("/search", (c) => c.json({ q: c.query.q, all: c.queryAll, h: c.header("x-test") }));
    const res = await fetchVia(app, "/search?q=hello&q=world&x=1", {
      headers: { "x-test": "yes" },
    });
    // query single returns first value
    const json = (await res.json()) as { q: string; all: Record<string, string[]>; h: string };
    expect(json.q).toBe("hello");
    expect(json.all).toEqual({ q: ["hello", "world"], x: ["1"] });
    expect(json.h).toBe("yes");
  });

  it("context lazy url and query", async () => {
    const app = new Mino();
    app.get("/lazy", (c) => {
      const u1 = c.url;
      const u2 = c.url;
      expect(u1).toBe(u2); // cached
      expect(c.path).toBe("/lazy");
      expect(c.method).toBe("GET");
      return c.text("ok");
    });
    const res = await fetchVia(app, "/lazy?x=1");
    expect(res.status).toBe(200);
  });

  it("context state get/set", async () => {
    const app = new Mino();
    app.get("/state", (c) => {
      c.set("foo", "bar");
      return c.json({ foo: c.get("foo"), v: c.var("foo") });
    });
    expect(await (await fetchVia(app, "/state")).json()).toEqual({ foo: "bar", v: "bar" });
  });

  it("context json/text/html/redirect", async () => {
    const app = new Mino();
    app.get("/json", (c) => c.json({ ok: true }, 201));
    app.get("/text", (c) => c.text("hi", 202));
    app.get("/html", (c) => c.html("<h1>hi</h1>"));
    app.get("/redirect", (c) => c.redirect("/json", 302));
    app.get("/body", (c) => c.body("custom", { status: 201 }));
    app.get("/status", (c) => c.status(202).json({ a: 1 }));

    expect((await fetchVia(app, "/json")).status).toBe(201);
    expect(await (await fetchVia(app, "/json")).json()).toEqual({ ok: true });
    expect((await fetchVia(app, "/text")).status).toBe(202);
    expect(await (await fetchVia(app, "/text")).text()).toBe("hi");
    expect((await fetchVia(app, "/html")).headers.get("content-type")).toContain("text/html");
    const red = await fetchVia(app, "/redirect");
    expect(red.status).toBe(302);
    expect(red.headers.get("location")).toBe("/redirect".replace("/redirect", "/json")); // actually location "/json"
    // check body
    expect(await (await fetchVia(app, "/body")).text()).toBe("custom");
    expect((await fetchVia(app, "/body")).status).toBe(201);
  });

  it("middleware order and next", async () => {
    const app = new Mino();
    const order: string[] = [];
    app.use(async (c, next) => {
      order.push("mw1:before");
      await next();
      order.push("mw1:after");
    });
    app.use(async (c, next) => {
      order.push("mw2:before");
      await next();
      order.push("mw2:after");
    });
    app.get("/", (c) => {
      order.push("handler");
      return c.text("ok");
    });
    const res = await fetchVia(app, "/");
    expect(res.status).toBe(200);
    expect(order).toEqual(["mw1:before", "mw2:before", "handler", "mw2:after", "mw1:after"]);
  });

  it("path-scoped middleware", async () => {
    const app = new Mino();
    let scopedRan = false;
    let globalRan = false;
    app.use(async (_c, next) => {
      globalRan = true;
      await next();
    });
    app.use("/api", async (_c, next) => {
      scopedRan = true;
      await next();
    });
    app.get("/api/test", (c) => c.text("api"));
    app.get("/other", (c) => c.text("other"));

    await fetchVia(app, "/api/test");
    expect(globalRan).toBe(true);
    expect(scopedRan).toBe(true);
    scopedRan = false;
    globalRan = false;
    await fetchVia(app, "/other");
    expect(globalRan).toBe(true);
    expect(scopedRan).toBe(false);
  });

  it("middleware can short-circuit with Response", async () => {
    const app = new Mino();
    app.use((c) => c.text("blocked", 403));
    app.get("/", (c) => c.text("should not reach"));
    const res = await fetchVia(app, "/");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("blocked");
  });

  it("next() called multiple times throws", async () => {
    const app = new Mino();
    app.use(async (_c, next) => {
      await next();
      await next(); // second call
    });
    app.get("/", (c) => c.text("ok"));
    const res = await fetchVia(app, "/");
    // errorHandler should catch and return 500
    expect(res.status).toBe(500);
  });

  it("handles 404 and onError", async () => {
    const app = new Mino();
    app.get("/exists", (c) => c.text("yes"));
    const res404 = await fetchVia(app, "/missing");
    expect(res404.status).toBe(404);

    app.onError((err, c) => {
      if (err instanceof HttpError) return c.json({ code: err.code }, err.status);
      return c.text("custom error", 500);
    });
    app.get("/throw", () => {
      throw new NotFoundError("gone");
    });
    const res = await fetchVia(app, "/throw");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "not_found" });

    app.get("/boom", () => {
      throw new Error("oops");
    });
    const res2 = await fetchVia(app, "/boom");
    expect(res2.status).toBe(500);
    expect(await res2.text()).toBe("custom error");
  });

  it("HEAD fallback to GET and strips body", async () => {
    const app = new Mino();
    app.get("/data", (c) => c.json({ x: 1 }));
    const res = await fetchVia(app, "/data", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(""); // body stripped
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("all methods", async () => {
    const app = new Mino();
    app.all("/all", (c) => c.text(c.method));
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetchVia(app, "/all", { method: m });
      expect(await res.text()).toBe(m);
    }
  });

  it("mount sub-app", async () => {
    const sub = new Mino();
    sub.get("/hello", (c) => c.text("sub hello"));
    const app = new Mino();
    app.mount("/api", sub);
    const res = await fetchVia(app, "/api/hello");
    expect(await res.text()).toBe("sub hello");
    expect((await fetchVia(app, "/hello")).status).toBe(404);
  });

  it("prefix option", async () => {
    const app = new Mino({ prefix: "/api" });
    app.get("/users", (c) => c.text("users"));
    expect((await fetchVia(app, "/api/users")).status).toBe(200);
    expect((await fetchVia(app, "/users")).status).toBe(404);
  });

  it("route method", async () => {
    const app = new Mino();
    app.route("GET", "/custom", (c) => c.text("custom"));
    expect(await (await fetchVia(app, "/custom")).text()).toBe("custom");
  });

  it("getRoutes introspection", () => {
    const app = new Mino();
    app.get("/a", (c) => c.text("a"));
    app.post("/b", (c) => c.text("b"));
    const routes = app.getRoutes();
    expect(routes.length).toBe(2);
    expect(routes[0]?.method).toBe("GET");
    expect(routes[0]?.path).toBe("/a");
  });

  it("HttpError helpers", () => {
    const err = new HttpError(400, "bad", { code: "bad" });
    expect(err.status).toBe(400);
    expect(err.toResponse().status).toBe(400);
    const nf = new NotFoundError();
    expect(nf.status).toBe(404);
    const br = new BadRequestError("oops");
    expect(br.status).toBe(400);
    const ve = new ValidationError("fail", [{ path: ["x"], message: "bad" }]);
    expect(ve.status).toBe(422);
  });

  it("Context body helpers", async () => {
    const app = new Mino();
    app.post("/echo", async (c) => {
      const json = await c.jsonBody<{ msg: string }>();
      return c.json(json);
    });
    app.post("/text", async (c) => c.text(await c.textBody()));
    app.post("/form", async (c) => {
      const fd = await c.formDataBody();
      return c.text(fd.get("x") as string);
    });
    const r1 = await fetchVia(app, "/echo", {
      method: "POST",
      body: JSON.stringify({ msg: "hi" }),
      headers: { "content-type": "application/json" },
    });
    expect(await r1.json()).toEqual({ msg: "hi" });
    const r2 = await fetchVia(app, "/text", { method: "POST", body: "plain" });
    expect(await r2.text()).toBe("plain");
    const fd = new FormData();
    fd.set("x", "y");
    const r3 = await app.fetch(new Request("http://localhost/form", { method: "POST", body: fd }));
    expect(await r3.text()).toBe("y");
  });

  it("SSE helpers", async () => {
    expect(formatSSE({ data: "hello", event: "msg", id: "1" })).toContain("data: hello");
    expect(formatSSE({ data: "a\nb" })).toContain("data: a\ndata: b");
    const stream = createSSEStream(
      (async function* () {
        yield { data: "hi" };
      })(),
    );
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toContain("data: hi");
    await reader.cancel();

    const app = new Mino();
    app.get("/sse", (c) =>
      c.sse(
        createSSEStream(
          (async function* () {
            yield { data: "event" };
          })(),
        ),
      ),
    );
    const res = await fetchVia(app, "/sse");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
  });

  it("validator with schema", async () => {
    const User = m.object({ name: m.string().min(2), email: m.string().email() });
    const app = new Mino();
    app.post("/users", validator("json", User), (c) => {
      const data = c.valid<{ name: string; email: string }>("json");
      return c.json(data);
    });
    const good = await fetchVia(app, "/users", {
      method: "POST",
      body: JSON.stringify({ name: "ab", email: "a@b.com" }),
      headers: { "content-type": "application/json" },
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ name: "ab", email: "a@b.com" });

    const bad = await fetchVia(app, "/users", {
      method: "POST",
      body: JSON.stringify({ name: "a", email: "bad" }),
      headers: { "content-type": "application/json" },
    });
    expect(bad.status).toBe(422);

    // query validator
    const Q = m.object({ q: m.string() });
    const app2 = new Mino();
    app2.get("/search", validator("query", Q), (c) => c.json(c.valid("query")));
    expect((await fetchVia(app2, "/search?q=hi")).status).toBe(200);
    expect((await fetchVia(app2, "/search")).status).toBe(422);

    // param validator
    const P = m.object({ id: m.string().uuid() });
    const app3 = new Mino();
    app3.get("/users/:id", validator("param", P), (c) => c.json(c.valid("param")));
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect((await fetchVia(app3, `/users/${uuid}`)).status).toBe(200);
    expect((await fetchVia(app3, "/users/bad")).status).toBe(422);
  });

  it("contract helpers", () => {
    const contract = defineRoute({ method: "GET", path: "/test", operation: { summary: "test" } });
    expect(contract.method).toBe("GET");
    const handler = (c: Context) => c.text("hi");
    const wrapped = withContract(contract, handler as never);
    expect(getContract(wrapped as object)).toEqual(contract);
    const described = describeRoute({ summary: "desc" }, handler as never);
    expect(getContract(described as object)?.operation?.summary).toBe("desc");
  });

  it("Router edge cases", () => {
    const r = new Router();
    r.add("GET", "/", [(c: Context) => c.text("root")]);
    r.add("GET", "/a/b", [(c: Context) => c.text("ab")]);
    expect(r.match("GET", "/")?.routePath).toBe("/");
    expect(r.match("GET", "/a/b")?.routePath).toBe("/a/b");
    expect(r.match("GET", "/a/b/")?.routePath).toBe("/a/b"); // trailing slash normalized
    expect(r.match("POST", "/")).toBe(null);
    expect(r.getRoutes().length).toBe(2);
    expect(Router.splitPath("/a/b?x=1")).toEqual(["a", "b"]);
    expect(Router.splitPath("/")).toEqual([]);
  });

  it("compose empty handlers", async () => {
    const fn = compose([]);
    const res = await fn(new Context(new Request("http://localhost/")));
    expect(res.status).toBe(404);
  });

  it("compose next without next call auto-continues", async () => {
    const app = new Mino();
    let secondRan = false;
    app.get(
      "/",
      (c) => c.text("first"),
      (_c, _next) => {
        secondRan = true;
        return undefined as unknown as Response;
      },
    );
    // Actually second handler as middleware that doesn't call next but returns void -> compose will auto-dispatch next
    // Our test: two handlers, first doesn't call next nor return Response, second should run via auto-dispatch
    const app2 = new Mino();
    app2.get(
      "/",
      (c, _next) => {
        /* no next, no return */
      },
      (c) => c.text("second"),
    );
    const res = await fetchVia(app2, "/");
    expect(await res.text()).toBe("second");
    void secondRan;
  });

  it("client createClient", async () => {
    const app = new Mino();
    app.get("/hello", (c) => c.json({ msg: "hi" }));
    app.get("/users/:id", (c) => c.json({ id: c.param("id") }));
    app.post("/echo", async (c) => c.json(await c.jsonBody()));

    // Use fetch override to route through app.fetch
    const client = createClient("http://localhost", {
      fetch: (url, init) => app.fetch(new Request(url, init as RequestInit)) as Promise<Response>,
    }) as unknown as Record<
      string,
      {
        $get: (opts?: unknown) => Promise<Response>;
        $post: (opts?: unknown) => Promise<Response>;
        $fetch: (opts?: unknown) => Promise<Response>;
      } & Record<string, unknown>
    >;
    const r1 = await (client.hello as unknown as { $get: () => Promise<Response> }).$get();
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ msg: "hi" });

    const r2 = await (
      (client.users as unknown as Record<string, { $get: (opts: unknown) => Promise<Response> }>)[
        ":id"
      ] as unknown as { $get: (opts: unknown) => Promise<Response> }
    ).$get({ param: { id: "123" } });
    expect(await r2.json()).toEqual({ id: "123" });

    const r3 = await (
      client.echo as unknown as { $post: (opts: unknown) => Promise<Response> }
    ).$post({ json: { x: 1 } });
    expect(await r3.json()).toEqual({ x: 1 });

    // query
    app.get("/search", (c) => c.json(c.queryAll));
    const r4 = await (
      client.search as unknown as { $get: (opts: unknown) => Promise<Response> }
    ).$get({ query: { q: "hi", arr: ["a", "b"] } });
    expect(await r4.json()).toEqual({ q: ["hi"], arr: ["a", "b"] });

    // hc alias
    const hcClient = hc("http://localhost", {
      fetch: (url, init) => app.fetch(new Request(url, init as RequestInit)) as Promise<Response>,
    }) as unknown as Record<string, { $get: () => Promise<Response> }>;
    const r5 = await (hcClient.hello as unknown as { $get: () => Promise<Response> }).$get();
    expect(r5.status).toBe(200);

    // $fetch with custom method
    const r6 = await (
      client.hello as unknown as { $fetch: (opts: unknown) => Promise<Response> }
    ).$fetch({ method: "GET" });
    expect(r6.status).toBe(200);
  });
});
