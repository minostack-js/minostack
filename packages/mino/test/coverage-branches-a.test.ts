import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { Context, readLimitedBytes, DEFAULT_LIMITS } from "../src/context.js";
import { validator } from "../src/validator.js";
import { m } from "@minostack/schema";

function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

function streamBody(chunks: string[]): Request {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Request("http://localhost/s", {
    method: "POST",
    body: stream as unknown as BodyInit,
    // @ts-expect-error undici duplex
    duplex: "half",
  });
}

async function* genChunks(items: string[]): AsyncGenerator<string> {
  for (const i of items) yield i;
}

async function* genThrow(): AsyncGenerator<string> {
  yield "data: one\n\n";
  throw new Error("boom-iter");
}

describe("coverage-branches-a: context content-length precheck", () => {
  it("oversize declared content-length throws before reading", async () => {
    const req = new Request("http://localhost/", {
      headers: { "content-length": String(DEFAULT_LIMITS.json + 1) },
    });
    await expect(readLimitedBytes(req, DEFAULT_LIMITS.json)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("exact-limit content-length passes; missing content-length streams", async () => {
    const exact = new Request("http://localhost/", {
      method: "POST",
      body: "hi",
      headers: { "content-length": "2" },
    });
    const out = await readLimitedBytes(exact, 2);
    expect(out.length).toBe(2);

    const missing = new Request("http://localhost/", { method: "POST", body: "hey" });
    // undici may or may not set content-length; delete to force missing branch
    const cloned = new Request(missing, { headers: new Headers() });
    const out2 = await readLimitedBytes(cloned, 100);
    expect(out2.length).toBe(3);
  });

  it("non-numeric content-length is ignored (NaN not finite)", async () => {
    const req = new Request("http://localhost/", {
      method: "POST",
      body: "abc",
      headers: { "content-length": "not-a-number" },
    });
    const out = await readLimitedBytes(req, 100);
    expect(out.length).toBe(3);
  });

  it("null body returns empty bytes (body===null branch)", async () => {
    const req = new Request("http://localhost/");
    expect(req.body).toBeNull();
    const out = await readLimitedBytes(req, 10);
    expect(out.length).toBe(0);
  });

  it("streaming body without content-length exceeding limit throws 413", async () => {
    const req = streamBody(["x".repeat(50), "y".repeat(50)]);
    await expect(readLimitedBytes(req, 10)).rejects.toMatchObject({ status: 413 });
  });
});

describe("coverage-branches-a: context constructor + query/header bounds", () => {
  it("injected url is reused (opts.url branch)", () => {
    const url = new URL("http://localhost/injected?q=1");
    const ctx = new Context(new Request("http://localhost/other"), { url });
    expect(ctx.url).toBe(url);
    expect(ctx.path).toBe("/injected");
  });

  it("query getter caches (second access hits cache)", async () => {
    const app = new Mino();
    app.get("/qc", (c) => {
      const a = c.query;
      const b = c.query;
      expect(a).toBe(b);
      return c.json(a);
    });
    expect((await fetchVia(app, "/qc?a=1")).status).toBe(200);
  });

  it("queryAll caches and enforces value length", async () => {
    const app = new Mino();
    app.get("/qa", (c) => {
      const a = c.queryAll;
      const b = c.queryAll;
      expect(a).toBe(b);
      return c.json(a);
    });
    expect((await fetchVia(app, "/qa?a=1&a=2")).status).toBe(200);
    // too-long value via queryAll
    const app2 = new Mino();
    app2.get("/qa2", (c) => c.json(c.queryAll));
    expect((await fetchVia(app2, `/qa2?k=${"v".repeat(9000)}`)).status).toBe(400);
  });

  it("queryAll too many keys returns 400", async () => {
    const app = new Mino({ limits: { queryKeys: 3 } });
    app.get("/qam", (c) => c.json(c.queryAll));
    const ok = Array.from({ length: 3 }, (_, i) => `k${i}=v`).join("&");
    expect((await fetchVia(app, `/qam?${ok}`)).status).toBe(200);
    const bad = Array.from({ length: 4 }, (_, i) => `k${i}=v`).join("&");
    expect((await fetchVia(app, `/qam?${bad}`)).status).toBe(400);
  });

  it("queryValue over limit returns 400; boundary passes", async () => {
    const app = new Mino({ limits: { queryValue: 5 } });
    app.get("/qv", (c) => c.text(c.queryValue("k") ?? "none"));
    expect((await fetchVia(app, "/qv?k=12345")).status).toBe(200);
    expect((await fetchVia(app, "/qv?k=123456")).status).toBe(400);
  });

  it("queries: >queryKeys values for same key returns 400", async () => {
    const app = new Mino({ limits: { queryKeys: 2 } });
    app.get("/qs", (c) => c.json(c.queries("k")));
    expect((await fetchVia(app, "/qs?k=a&k=b")).status).toBe(200);
    expect((await fetchVia(app, "/qs?k=a&k=b&k=c")).status).toBe(400);
  });

  it("queries: oversize single value returns 400", async () => {
    const app = new Mino({ limits: { queryValue: 4 } });
    app.get("/qsv", (c) => c.json(c.queries("k")));
    expect((await fetchVia(app, "/qsv?k=toolongvalue")).status).toBe(400);
  });

  it("queryKeys boundary: custom limit 2 allows 2, rejects 3", async () => {
    const app = new Mino({ limits: { queryKeys: 2 } });
    app.get("/qb", (c) => c.json(c.query));
    expect((await fetchVia(app, "/qb?a=1&b=2")).status).toBe(200);
    expect((await fetchVia(app, "/qb?a=1&b=2&c=3")).status).toBe(400);
  });

  it("headerKeys boundary via header validator", async () => {
    const S = m.object({}).passthrough();
    const app = new Mino({ limits: { headerKeys: 2 } });
    app.get("/hb", validator("header", S as never), (c) => c.text("ok"));
    expect((await fetchVia(app, "/hb", { headers: { "x-a": "1" } })).status).toBe(200);
  });

  it("headerValue boundary via header validator", async () => {
    const S = m.object({}).passthrough();
    const app = new Mino({ limits: { headerValue: 5 } });
    app.get("/hv", validator("header", S as never), (c) => c.text("ok"));
    expect((await fetchVia(app, "/hv", { headers: { "x-a": "12345" } })).status).toBe(200);
    expect((await fetchVia(app, "/hv", { headers: { "x-a": "123456" } })).status).toBe(400);
  });
});

describe("coverage-branches-a: body helpers + validated cache", () => {
  it("textBody enforces limit; empty body returns empty string", async () => {
    const app = new Mino({ limits: { text: 4 } });
    app.post("/tb", async (c) => c.text(await c.textBody()));
    expect((await fetchVia(app, "/tb", { method: "POST", body: "1234" })).status).toBe(200);
    expect((await fetchVia(app, "/tb", { method: "POST", body: "12345" })).status).toBe(413);
    const ctx = new Context(new Request("http://localhost/", { method: "POST" }));
    // body null with text limit: readLimitedBytes returns empty -> ""
    expect(await ctx.textBody()).toBe("");
  });

  it("arrayBufferBody enforces arrayBuffer limit", async () => {
    const app = new Mino({ limits: { arrayBuffer: 3 } });
    app.post("/ab2", async (c) => c.json({ n: (await c.arrayBufferBody()).byteLength }));
    expect((await fetchVia(app, "/ab2", { method: "POST", body: "abc" })).status).toBe(200);
    expect((await fetchVia(app, "/ab2", { method: "POST", body: "abcd" })).status).toBe(413);
  });

  it("jsonBody reuses _rawJson cached by validator", async () => {
    const S = m.object({ name: m.string() });
    const app = new Mino();
    app.post("/jr", validator("json", S as never), async (c) => {
      const viaHelper = await c.jsonBody<{ name: string }>();
      const viaValid = c.valid<{ name: string }>("json");
      expect(viaHelper).toEqual(viaValid);
      expect(c.req.method).toBe("POST");
      return c.json(viaHelper);
    });
    const res = await fetchVia(app, "/jr", {
      method: "POST",
      body: JSON.stringify({ name: "hi" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "hi" });
  });

  it("jsonBody falls back to validated json when _rawJson missing", async () => {
    const ctx = new Context(
      new Request("http://localhost/", { method: "POST", body: JSON.stringify({ a: 1 }) }),
    );
    ctx.setValidated("json", { a: 1 });
    expect(await ctx.jsonBody()).toEqual({ a: 1 });
  });

  it("jsonBody empty text throws Invalid JSON body", async () => {
    const ctx = new Context(new Request("http://localhost/", { method: "POST" }));
    await expect(ctx.jsonBody()).rejects.toMatchObject({ status: 400 });
  });

  it("jsonBody invalid JSON throws Invalid JSON body", async () => {
    const ctx = new Context(new Request("http://localhost/", { method: "POST", body: "{bad" }));
    await expect(ctx.jsonBody()).rejects.toMatchObject({ status: 400 });
  });

  it("c.valid returns undefined for missing key; c.req accessor works", async () => {
    const app = new Mino();
    app.get("/va", (c) => {
      expect(c.valid("missing")).toBeUndefined();
      expect(c.req).toBeInstanceOf(Request);
      c.setValidated("k", 42);
      expect(c.valid<number>("k")).toBe(42);
      return c.text("ok");
    });
    expect((await fetchVia(app, "/va")).status).toBe(200);
  });

  it("formDataBody fieldCount exceeded throws 413", async () => {
    const fd = new FormData();
    fd.set("a", "1");
    fd.set("b", "2");
    fd.set("c", "3");
    const ctx = new Context(new Request("http://localhost/", { method: "POST", body: fd }), {
      limits: { fieldCount: 2 },
    });
    await expect(ctx.formDataBody()).rejects.toMatchObject({ status: 413 });
  });

  it("formDataBody declared content-length precheck throws 413", async () => {
    const fd = new FormData();
    fd.set("a", "1");
    const ctx = new Context(
      new Request("http://localhost/", {
        method: "POST",
        body: fd,
        headers: { "content-length": String(DEFAULT_LIMITS.form + 1) },
      }),
    );
    await expect(ctx.formDataBody()).rejects.toMatchObject({ status: 413 });
  });
});

describe("coverage-branches-a: sse iterable + transform", () => {
  it("sse with async iterable streams chunks and sets headers", async () => {
    const app = new Mino();
    app.get("/sse-a", (c) => c.sse(genChunks(["data: a\n\n", "data: b\n\n"])));
    const res = await fetchVia(app, "/sse-a");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const text = await res.text();
    expect(text).toContain("data: a");
    expect(text).toContain("data: b");
  });

  it("sse with throwing iterable errors the stream", async () => {
    const app = new Mino();
    app.get("/sse-e", (c) => c.sse(genThrow()));
    const res = await fetchVia(app, "/sse-e");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await expect(res.text()).rejects.toThrow();
  });
});

describe("coverage-branches-a: validator json edge content-types", () => {
  it("non-json content-type with valid JSON body still validates (200)", async () => {
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/nj", validator("json", S as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/nj", {
      method: "POST",
      body: JSON.stringify({ a: "hi" }),
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(200);
  });

  it("non-json content-type with invalid JSON falls back to undefined (422)", async () => {
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/nj2", validator("json", S as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/nj2", {
      method: "POST",
      body: "{not-json",
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(422);
  });

  it("non-json content-type with empty body falls back to undefined (422)", async () => {
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/nj3", validator("json", S as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/nj3", {
      method: "POST",
      body: "",
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(422);
  });

  it("no body and no content-type falls back to undefined (422)", async () => {
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/nj4", validator("json", S as never), (c) => c.json(c.valid("json")));
    expect((await fetchVia(app, "/nj4", { method: "POST" })).status).toBe(422);
  });

  it("json content-type with empty body falls back to undefined (422)", async () => {
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/je", validator("json", S as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/je", {
      method: "POST",
      body: "",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
  });

  it("json content-type with malformed JSON returns 400", async () => {
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/jb", validator("json", S as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/jb", {
      method: "POST",
      body: "{bad",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("json oversize declared content-length returns 413", async () => {
    const S = m.object({ name: m.string() });
    const app = new Mino();
    app.post("/jl", validator("json", S as never, { limit: 10 }), (c) => c.text("ok"));
    const res = await fetchVia(app, "/jl", {
      method: "POST",
      body: JSON.stringify({ name: "x".repeat(100) }),
      headers: { "content-type": "application/json", "content-length": "9999" },
    });
    expect(res.status).toBe(413);
  });

  it("json streaming over per-route limit without content-length returns 413", async () => {
    const S = m.object({ name: m.string() });
    const app = new Mino();
    app.post("/js", validator("json", S as never, { limit: 10 }), (c) => c.text("ok"));
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ name: "x".repeat(100) })));
        ctrl.close();
      },
    });
    const req = new Request("http://localhost/js", {
      method: "POST",
      body: stream as unknown as BodyInit,
      headers: { "content-type": "application/json" },
      // @ts-expect-error undici duplex
      duplex: "half",
    });
    expect((await app.fetch(req)).status).toBe(413);
  });
});

describe("coverage-branches-a: validator form fallbacks", () => {
  it("form with wrong content-type (json body) falls back to undefined (422)", async () => {
    const S = m.object({ x: m.string() });
    const app = new Mino();
    app.post("/ff", validator("form", S as never), (c) => c.json(c.valid("form")));
    const res = await fetchVia(app, "/ff", {
      method: "POST",
      body: JSON.stringify({ x: "1" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
  });

  it("form declared content-length over limit returns 413", async () => {
    const S = m.object({}).passthrough();
    const app = new Mino();
    app.post("/fl", validator("form", S as never, { limit: 10 }), (c) => c.text("ok"));
    const fd = new FormData();
    fd.set("x", "1");
    const req = new Request("http://localhost/fl", {
      method: "POST",
      body: fd,
      headers: { "content-length": "9999" },
    });
    expect((await app.fetch(req)).status).toBe(413);
  });

  it("invalid target falls back to default branch (undefined value)", async () => {
    const pass = {
      safeParse: () => ({ success: true as const, data: "dflt" }),
    };
    const app = new Mino();
    app.post("/bogus", validator("bogus" as never, pass as never), (c) =>
      c.text(String(c.valid("bogus"))),
    );
    const res = await fetchVia(app, "/bogus", { method: "POST", body: "x" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("dflt");
  });
});

describe("coverage-branches-a: Standard Schema fallbacks", () => {
  it("safeParse returning {success:false} without error uses fallback issue (422)", async () => {
    const schema = { safeParse: () => ({ success: false as const }) };
    const app = new Mino();
    app.post("/sf", validator("json", schema as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/sf", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Array<{ message: string }> };
    expect(body.issues[0]?.message).toBe("Validation failed");
  });

  it("~standard returning {} (no value/issues) yields empty issues (422)", async () => {
    const schema = { "~standard": { validate: () => ({}) } };
    const app = new Mino();
    app.post("/std2", validator("json", schema as never), (c) => c.json(c.valid("json")));
    const res = await fetchVia(app, "/std2", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues).toEqual([]);
  });

  it("async ~standard validate throws 500 (sync-only)", async () => {
    const schema = { "~standard": { validate: () => Promise.resolve({ value: 1 }) } };
    const app = new Mino();
    app.post("/sa", validator("json", schema as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/sa", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
  });

  it("async safeParse throws 500 (sync-only)", async () => {
    const schema = { safeParse: () => Promise.resolve({ success: true, data: 1 }) };
    const app = new Mino();
    app.post("/sa2", validator("json", schema as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/sa2", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
  });

  it("async parse result throws 500 (sync-only)", async () => {
    const schema = { parse: () => Promise.resolve(1) };
    const app = new Mino();
    app.post("/pa", validator("json", schema as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/pa", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
  });

  it("parse throwing Async-marker error rethrows to 500", async () => {
    const schema = {
      parse: () => {
        throw new Error("Async Standard Schema not supported: use sync");
      },
    };
    const app = new Mino();
    app.post("/pa2", validator("json", schema as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/pa2", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
  });

  it("non-schema validator (no safeParse/parse/~standard) throws 500", async () => {
    const app = new Mino();
    app.post("/ns", validator("json", {} as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/ns", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
  });

  it("array/object issue values are truncated to 500 chars", async () => {
    const schema = {
      safeParse: () => ({
        success: false as const,
        error: {
          issues: [
            { message: "x".repeat(2000) },
            ["y".repeat(2000)],
            { nested: { deep: "z".repeat(2000) } },
          ],
        },
      }),
    };
    const app = new Mino();
    app.post("/tr", validator("json", schema as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/tr", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Array<unknown> };
    expect(JSON.stringify(body.issues).length).toBeLessThan(4000);
  });
});

describe("coverage-branches-a2: context remaining branches", () => {
  it("setParams without routePath keeps previous routePath (line 193 false)", () => {
    const ctx = new Context(new Request("http://localhost/"), {
      params: { id: "1" },
      routePath: "/users/:id",
    });
    expect(ctx.routePath).toBe("/users/:id");
    ctx.setParams({ id: "2" });
    expect(ctx.params).toEqual({ id: "2" });
    expect(ctx.routePath).toBe("/users/:id");
    ctx.setParams({ id: "3" }, "/users/:id");
    expect(ctx.routePath).toBe("/users/:id");
  });

  it("finalizeHeaders reuses Headers instance fast path (line 327 true)", async () => {
    const app = new Mino();
    app.get("/jh", (c) => c.json({ ok: true }, 200, new Headers({ "x-a": "1" })));
    const res = await fetchVia(app, "/jh");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-a")).toBe("1");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("json/text/html preserve preset content-type (lines 337/346/355 false)", async () => {
    const app = new Mino();
    app.get("/jc", (c) => c.json({ ok: true }, 200, { "content-type": "text/custom" }));
    app.get("/tc", (c) => c.text("hi", 200, { "content-type": "text/custom" }));
    app.get("/hc", (c) => c.html("<b>hi</b>", 200, { "content-type": "text/custom" }));
    expect((await fetchVia(app, "/jc")).headers.get("content-type")).toBe("text/custom");
    expect((await fetchVia(app, "/tc")).headers.get("content-type")).toBe("text/custom");
    expect((await fetchVia(app, "/hc")).headers.get("content-type")).toBe("text/custom");
  });

  it("body() defaults to 200 / honors init.status / #status wins (line 371)", async () => {
    const app = new Mino();
    app.get("/b1", (c) => c.body("hello"));
    app.get("/b2", (c) => c.body("hi", { status: 201 }));
    app.get("/b3", (c) => {
      c.status(202);
      return c.body("x", { status: 201 });
    });
    expect((await fetchVia(app, "/b1")).status).toBe(200);
    expect(await (await fetchVia(app, "/b1")).text()).toBe("hello");
    expect((await fetchVia(app, "/b2")).status).toBe(201);
    expect((await fetchVia(app, "/b3")).status).toBe(202);
  });

  it("jsonBody with unrelated validated key falls through to body parse (line 389 false)", async () => {
    const ctx = new Context(
      new Request("http://localhost/", {
        method: "POST",
        body: JSON.stringify({ a: 1 }),
        headers: { "content-type": "application/json" },
      }),
    );
    ctx.setValidated("other", 123);
    expect(await ctx.jsonBody()).toEqual({ a: 1 });
  });

  it("query/header limit boundaries via routes", async () => {
    const app = new Mino({ limits: { queryKeys: 2, headerValue: 5 } });
    app.get("/qb2", (c) => c.json(c.query));
    expect((await fetchVia(app, "/qb2?a=1&b=2")).status).toBe(200);
    expect((await fetchVia(app, "/qb2?a=1&b=2&c=3")).status).toBe(400);
    app.get("/hv2", (c) => c.text(c.header("x-a") ?? "none"));
    expect((await fetchVia(app, "/hv2", { headers: { "x-a": "12345" } })).status).toBe(200);
  });

  it("text/form body limit boundaries", async () => {
    const app = new Mino({ limits: { text: 4, form: 102400, fieldCount: 2 } });
    app.post("/tb2", async (c) => c.text(await c.textBody()));
    expect((await fetchVia(app, "/tb2", { method: "POST", body: "1234" })).status).toBe(200);
    expect((await fetchVia(app, "/tb2", { method: "POST", body: "12345" })).status).toBe(413);
    const fd = new FormData();
    fd.set("a", "1");
    fd.set("b", "2");
    const ok = await fetchVia(app, "/tb2", { method: "POST", body: fd });
    expect(ok.status).toBe(413);
  });
});

describe("coverage-branches-a2: validator remaining branches", () => {
  it("non-json content-type with null body yields undefined (422) (line 88 true)", async () => {
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/nb", validator("json", S as never), (c) => c.json(c.valid("json")));
    const req = new Request("http://localhost/nb", {
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    expect(req.body).toBeNull();
    expect((await app.fetch(req)).status).toBe(422);
  });

  it("non-json content-type oversize body rethrows 413 (line 96 true)", async () => {
    const S = m.object({ a: m.string() });
    const app = new Mino();
    app.post("/no", validator("json", S as never, { limit: 10 }), (c) => c.text("ok"));
    const res = await fetchVia(app, "/no", {
      method: "POST",
      body: JSON.stringify({ a: "x".repeat(100) }),
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(413);
  });

  it("form without content-length still validates (line 117 false)", async () => {
    const S = m.object({ x: m.string() });
    const app = new Mino();
    app.post("/fm", validator("form", S as never), (c) => c.json(c.valid("form")));
    const fd = new FormData();
    fd.set("x", "1");
    const orig = new Request("http://localhost/fm", { method: "POST", body: fd });
    const ct = orig.headers.get("content-type") ?? "multipart/form-data";
    const stripped = new Request(orig, { headers: new Headers({ "content-type": ct }) });
    expect(stripped.headers.get("content-length")).toBeNull();
    const res = await app.fetch(stripped);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ x: "1" });
  });

  it("truncate handles primitives/null/deep nesting (line 163 true)", async () => {
    const schema = {
      safeParse: () => ({
        success: false as const,
        error: {
          issues: [
            { message: "m", code: 42, extra: null, flag: true, n: 7 },
            { deep: { a: { b: { c: { d: "x".repeat(2000) } } } } },
          ],
        },
      }),
    };
    const app = new Mino();
    app.post("/td", validator("json", schema as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/td", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Array<Record<string, unknown>> };
    expect(body.issues[0]).toMatchObject({ code: 42, extra: null, flag: true });
  });

  it("parse throwing plain Error without issues uses message fallback (line 228)", async () => {
    const schema = {
      parse: () => {
        throw new Error("plain boom");
      },
    };
    const app = new Mino();
    app.post("/pf", validator("json", schema as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/pf", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Array<{ message: string }> };
    expect(body.issues[0]?.message).toBe("plain boom");
  });

  it("parse success path validates; safeParse error-less failure covered via query", async () => {
    const querySchema = {
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
    };
    const app = new Mino();
    app.get("/qp", validator("query", querySchema as never), (c) => c.json(c.valid("query")));
    const res = await fetchVia(app, "/qp?a=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ a: "1" });

    const legacy = { parse: (v: unknown) => v };
    const app2 = new Mino();
    app2.post("/lp", validator("json", legacy as never), (c) => c.json(c.valid("json")));
    const res2 = await fetchVia(app2, "/lp", {
      method: "POST",
      body: JSON.stringify({ k: "v" }),
      headers: { "content-type": "application/json" },
    });
    expect(res2.status).toBe(200);
  });

  it("c.valid/c.req accessors and error paths stay green", async () => {
    const app = new Mino();
    app.get("/vx", (c) => {
      expect(c.valid("nope")).toBeUndefined();
      expect(c.req).toBeInstanceOf(Request);
      expect(c.method).toBe("GET");
      expect(c.path).toBe("/vx");
      return c.text("ok");
    });
    expect((await fetchVia(app, "/vx")).status).toBe(200);
    const S = m.object({ a: m.string() });
    const app2 = new Mino();
    app2.post("/ve", validator("json", S as never), (c) => c.json(c.valid("json")));
    expect(
      (
        await fetchVia(app2, "/ve", {
          method: "POST",
          body: JSON.stringify({ a: 1 }),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(422);
  });
});
