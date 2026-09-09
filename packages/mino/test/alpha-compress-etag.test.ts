import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { compress } from "../src/compress.js";
import { etag, conditional, generateETag } from "../src/etag.js";
import { serveStatic, type StaticLoader } from "../src/static.js";
import { validator, validatorAsync } from "../src/validator.js";
import { DEFAULT_LIMITS } from "../src/context.js";

function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

async function gunzip(res: Response, encoding: "gzip" | "deflate"): Promise<string> {
  const buf = await res.arrayBuffer();
  const ds = new DecompressionStream(encoding);
  const src = new Response(buf as unknown as BodyInit).body;
  if (!src) return "";
  const out = await new Response(src.pipeThrough(ds) as unknown as BodyInit).arrayBuffer();
  return new TextDecoder().decode(out);
}

const BIG = "x".repeat(5000);

// ─── F5: compress ────────────────────────────────────────────────────────────
describe("alpha F5: compress", () => {
  it("gzip applied + headers, body round-trips", async () => {
    const app = new Mino();
    app.use(compress());
    app.get("/big", (c) => c.text(BIG));
    const res = await fetchVia(app, "/big", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(await gunzip(res, "gzip")).toBe(BIG);
  });

  it("below-threshold responses skip compression", async () => {
    const app = new Mino();
    app.use(compress());
    app.get("/small", (c) => c.text("hi"));
    const res = await fetchVia(app, "/small", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe(null);
    expect(await res.text()).toBe("hi");
  });

  it("SSE (text/event-stream) is never compressed", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 1 }));
    app.get("/sse", () => {
      return new Response(`data: ${BIG}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const res = await fetchVia(app, "/sse", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe(null);
    expect(await res.text()).toContain("data: ");
  });

  it("already-encoded responses are left alone", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 1 }));
    app.get("/enc", () => {
      return new Response(BIG, {
        headers: { "content-encoding": "gzip", "content-type": "text/plain" },
      });
    });
    const res = await fetchVia(app, "/enc", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await res.text()).toBe(BIG);
  });

  it("HEAD / 204 / 304 skip compression", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 1 }));
    app.get("/big", (c) => c.text(BIG));
    app.get("/empty", () => new Response(null, { status: 204 }));
    const head = await app.fetch(
      new Request("http://localhost/big", {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      }),
    );
    expect(head.headers.get("content-encoding")).toBe(null);
    const empty = await fetchVia(app, "/empty", { headers: { "accept-encoding": "gzip" } });
    expect(empty.status).toBe(204);
    expect(empty.headers.get("content-encoding")).toBe(null);
  });

  it("deflate used when client only accepts deflate; br-only skips", async () => {
    const app = new Mino();
    app.use(compress());
    app.get("/big", (c) => c.text(BIG));
    const def = await fetchVia(app, "/big", { headers: { "accept-encoding": "deflate" } });
    expect(def.headers.get("content-encoding")).toBe("deflate");
    expect(await gunzip(def, "deflate")).toBe(BIG);
    const br = await fetchVia(app, "/big", { headers: { "accept-encoding": "br" } });
    expect(br.headers.get("content-encoding")).toBe(null);
  });

  it("no accept-encoding header skips compression", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 1 }));
    app.get("/big", (c) => c.text(BIG));
    const res = await app.fetch(new Request("http://localhost/big", { headers: new Headers() }));
    expect(res.headers.get("content-encoding")).toBe(null);
  });
});

// ─── F6: etag ────────────────────────────────────────────────────────────────
describe("alpha F6: etag", () => {
  it("sets a weak ETag in <len>-<hash> form", async () => {
    const app = new Mino();
    app.use(etag());
    app.get("/t", (c) => c.text("hello"));
    const res = await fetchVia(app, "/t");
    const tag = res.headers.get("etag") ?? "";
    expect(tag.startsWith("W/")).toBe(true);
    expect(tag).toMatch(/^W\/"\d+-[0-9a-f]{8}"$/);
    expect(await res.text()).toBe("hello");
  });

  it("strong tags when weak:false", async () => {
    const app = new Mino();
    app.use(etag({ weak: false }));
    app.get("/t", (c) => c.text("hello"));
    const tag = (await fetchVia(app, "/t")).headers.get("etag") ?? "";
    expect(tag.startsWith("W/")).toBe(false);
    expect(tag).toMatch(/^"\d+-[0-9a-f]{8}"$/);
  });

  it("If-None-Match match returns 304 with stripped body", async () => {
    const app = new Mino();
    app.use(etag());
    app.get("/t", (c) => c.text("hello"));
    const first = await fetchVia(app, "/t");
    const tag = first.headers.get("etag") ?? "";
    const second = await fetchVia(app, "/t", { headers: { "if-none-match": tag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(tag);
  });

  it("conditional() honors pre-set ETag without recomputing", async () => {
    const app = new Mino();
    app.use(conditional());
    app.get("/t", () => {
      return new Response("hello", { headers: { etag: '"1-abc"', "cache-control": "no-cache" } });
    });
    const hit = await fetchVia(app, "/t", { headers: { "if-none-match": '"1-abc"' } });
    expect(hit.status).toBe(304);
    expect(hit.headers.get("etag")).toBe('"1-abc"');
    const miss = await fetchVia(app, "/t", { headers: { "if-none-match": '"9-zzz"' } });
    expect(miss.status).toBe(200);
    expect(await miss.text()).toBe("hello");
  });

  it("generateETag is deterministic and input-sensitive", () => {
    const a = generateETag(new TextEncoder().encode("hello"));
    const b = generateETag(new TextEncoder().encode("hello"));
    const c = generateETag(new TextEncoder().encode("world"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^"\d+-[0-9a-f]{8}"$/);
  });
});

// ─── F6: static ──────────────────────────────────────────────────────────────
function memLoader(): StaticLoader {
  const enc = new TextEncoder();
  const files = new Map<string, { body: Uint8Array; type?: string; mtime?: Date }>([
    [
      "hello.txt",
      {
        body: enc.encode("hello world"),
        type: "text/plain",
        mtime: new Date("2024-01-01T00:00:00Z"),
      },
    ],
    ["app.js", { body: enc.encode("console.log(1)"), mtime: new Date("2024-06-01T00:00:00Z") }],
  ]);
  return {
    load: async (p: string) => files.get(p),
  };
}

describe("alpha F6: static", () => {
  it("serves file with content-type / length / last-modified / cache-control / etag", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: memLoader() }));
    const res = await fetchVia(app, "/static/hello.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-length")).toBe(String("hello world".length));
    expect(res.headers.get("last-modified")).toBe(new Date("2024-01-01T00:00:00Z").toUTCString());
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("etag")).toMatch(/^W\/"\d+-[0-9a-f]{8}"$/);
    expect(await res.text()).toBe("hello world");
  });

  it("infers content-type from extension when loader omits it", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: memLoader() }));
    const res = await fetchVia(app, "/static/app.js");
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("blocks path traversal (never serves outside root)", async () => {
    // WHATWG URL normalizes %2e%2e dot segments before the handler runs, so
    // this escapes the prefix entirely — the must-hold is a 4xx JSON body and
    // never the loader content.
    const app = new Mino();
    app.use(serveStatic({ loader: memLoader() }));
    const res = await fetchVia(app, "/static/%2e%2e/secret.txt");
    expect([403, 404]).toContain(res.status);
    expect(await res.json()).toMatchObject({ status: res.status });
  });

  it("rejects raw .. segments with 403 (stub context bypassing URL normalization)", async () => {
    // Real Requests normalize `..` in the URL constructor, so exercise the
    // handler guard directly with a Context-shaped stub (as a runtime adapter
    // passing through a raw target might).
    const { normalizeStaticPath } = await import("../src/static.js");
    expect(normalizeStaticPath("/../secret.txt")).toBe(null);
    expect(normalizeStaticPath("/a/../../b")).toBe(null);
    expect(normalizeStaticPath("/a/b/../c")).toBe("/a/c");

    const handler = serveStatic({ loader: memLoader() });
    let stored: Response | undefined;
    const stub = {
      method: "GET",
      path: "/static/../secret.txt",
      header: (_n: string) => undefined,
      setResponse: (r: Response) => {
        stored = r;
      },
    };
    await (handler as unknown as (c: unknown, n: () => Promise<void>) => Promise<unknown>)(
      stub,
      async () => {},
    );
    expect(stored?.status).toBe(403);
  });

  it("returns JSON 404 when loader has no entry", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: memLoader() }));
    const res = await fetchVia(app, "/static/missing.txt");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ status: 404 });
  });

  it("denies dotfiles by default", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: memLoader() }));
    const res = await fetchVia(app, "/static/.env");
    expect(res.status).toBe(403);
  });

  it("answers 304 on matching If-None-Match", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: memLoader() }));
    const first = await fetchVia(app, "/static/hello.txt");
    const tag = first.headers.get("etag") ?? "";
    const second = await fetchVia(app, "/static/hello.txt", {
      headers: { "if-none-match": tag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });
});

// ─── G1: multipart file limits ───────────────────────────────────────────────
describe("alpha G1: multipart file limits", () => {
  it("exposes fileCount=10 / fileSize=5MB defaults", () => {
    expect(DEFAULT_LIMITS.fileCount).toBe(10);
    expect(DEFAULT_LIMITS.fileSize).toBe(5 * 1024 * 1024);
  });

  it("rejects too many files with 413", async () => {
    const pass = { safeParse: () => ({ success: true as const, data: {} }) };
    const app = new Mino();
    app.post("/u", validator("form", pass as never, { fileCount: 1 }), (c) => c.text("ok"));
    const fd = new FormData();
    fd.append("a", new File(["x"], "a.txt", { type: "text/plain" }));
    fd.append("b", new File(["y"], "b.txt", { type: "text/plain" }));
    const res = await app.fetch(new Request("http://localhost/u", { method: "POST", body: fd }));
    expect(res.status).toBe(413);
  });

  it("rejects oversize files with 413", async () => {
    const pass = { safeParse: () => ({ success: true as const, data: {} }) };
    const app = new Mino();
    app.post("/u", validator("form", pass as never, { fileSize: 4 }), (c) => c.text("ok"));
    const fd = new FormData();
    fd.append("f", new File(["12345678"], "big.txt", { type: "text/plain" }));
    const res = await app.fetch(new Request("http://localhost/u", { method: "POST", body: fd }));
    expect(res.status).toBe(413);
  });

  it("small files within overrides pass", async () => {
    const pass = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };
    const app = new Mino();
    app.post("/u", validator("form", pass as never, { fileCount: 2, fileSize: 64 }), (c) =>
      c.text("ok"),
    );
    const fd = new FormData();
    fd.append("f", new File(["hi"], "a.txt", { type: "text/plain" }));
    const res = await app.fetch(new Request("http://localhost/u", { method: "POST", body: fd }));
    expect(res.status).toBe(200);
  });
});

// ─── G2: validatorAsync ──────────────────────────────────────────────────────
describe("alpha G2: validatorAsync", () => {
  async function postAsync(schema: unknown, body: unknown = { name: "x" }): Promise<Response> {
    const app = new Mino();
    app.post("/v", validatorAsync("json", schema as never), (c) => c.json(c.valid("json")));
    return fetchVia(app, "/v", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  it("async ~standard pass resolves data", async () => {
    const schema = { "~standard": { validate: async (v: unknown) => ({ value: v }) } };
    const res = await postAsync(schema);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "x" });
  });

  it("async ~standard fail returns 422 with issues", async () => {
    const schema = {
      "~standard": { validate: async (_v: unknown) => ({ issues: [{ message: "nope" }] }) },
    };
    const res = await postAsync(schema);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ status: 422 });
  });

  it("async safeParse pass and fail", async () => {
    const ok = { safeParse: async (v: unknown) => ({ success: true as const, data: v }) };
    expect((await postAsync(ok)).status).toBe(200);
    const bad = {
      safeParse: async (_v: unknown) => ({
        success: false as const,
        error: { issues: [{ message: "bad" }] },
      }),
    };
    const res = await postAsync(bad);
    expect(res.status).toBe(422);
  });

  it("async parse resolves and rejects", async () => {
    const ok = { parse: async (v: unknown) => v };
    expect((await postAsync(ok)).status).toBe(200);
    const bad = {
      parse: async (_v: unknown) => {
        throw { issues: [{ message: "boom" }] };
      },
    };
    expect((await postAsync(bad)).status).toBe(422);
  });

  it("sync validator still rejects async schema with 500", async () => {
    const app = new Mino();
    const asyncSchema = { "~standard": { validate: async (v: unknown) => ({ value: v }) } };
    app.post("/a", validator("json", asyncSchema as never), (c) => c.text("unreached"));
    const res = await fetchVia(app, "/a", {
      method: "POST",
      body: JSON.stringify({ x: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(500);
  });

  it("validatorAsync accepts sync schemas too", async () => {
    const sync = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };
    expect((await postAsync(sync)).status).toBe(200);
  });

  it("validatorAsync truncates overlong async issues", async () => {
    const schema = {
      "~standard": {
        validate: async (_v: unknown) => ({ issues: [{ message: "z".repeat(2000) }] }),
      },
    };
    const res = await postAsync(schema);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: Array<{ message: string }> };
    expect(body.issues[0]?.message.length).toBeLessThanOrEqual(500);
  });
});
