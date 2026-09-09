import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { compress } from "../src/compress.js";
import { etag, conditional } from "../src/etag.js";
import { serveStatic, normalizeStaticPath, type StaticLoader } from "../src/static.js";

function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

async function gunzip(res: Response, encoding: "gzip" | "deflate"): Promise<string> {
  const buf = await res.arrayBuffer();
  const ds = new DecompressionStream(encoding);
  const src = new Response(buf as unknown as BodyInit).body;
  if (!src) return "";
  return new TextDecoder().decode(
    await new Response(src.pipeThrough(ds) as unknown as BodyInit).arrayBuffer(),
  );
}

const BIG = "y".repeat(3000);

function stubCtx(over: Record<string, unknown>) {
  let stored: Response | undefined;
  const stub = {
    method: "GET",
    header: (_n: string) => undefined,
    setResponse: (r: Response) => {
      stored = r;
    },
    res: undefined,
    ...over,
  };
  return { stub, get: () => stored };
}

// ─── compress edges ──────────────────────────────────────────────────────────
describe("alpha coverage: compress edges", () => {
  it("q=0 refusal skips gzip, falls back to deflate", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 8 }));
    app.get("/b", (c) => c.text(BIG));
    const res = await fetchVia(app, "/b", { headers: { "accept-encoding": "gzip;q=0, deflate" } });
    expect(res.headers.get("content-encoding")).toBe("deflate");
    expect(await gunzip(res, "deflate")).toBe(BIG);
  });

  it("wildcard * accepts server preference (gzip)", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 8 }));
    app.get("/b", (c) => c.text(BIG));
    const res = await fetchVia(app, "/b", { headers: { "accept-encoding": "*" } });
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("tolerates odd tokens: empty parts, bad q, uppercase", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 8 }));
    app.get("/b", (c) => c.text(BIG));
    const badQ = await fetchVia(app, "/b", { headers: { "accept-encoding": "gzip;q=abc" } });
    expect(badQ.headers.get("content-encoding")).toBe("gzip");
    const sparse = await fetchVia(app, "/b", { headers: { "accept-encoding": "gzip, , deflate" } });
    expect(sparse.headers.get("content-encoding")).toBe("gzip");
    const upper = await fetchVia(app, "/b", { headers: { "accept-encoding": "GZip" } });
    expect(upper.headers.get("content-encoding")).toBe("gzip");
    const refused = await fetchVia(app, "/b", { headers: { "accept-encoding": "*;q=0" } });
    expect(refused.headers.get("content-encoding")).toBe(null);
  });

  it("custom encodings subset restricts negotiation", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 8, encodings: ["deflate"] }));
    app.get("/b", (c) => c.text(BIG));
    const res = await fetchVia(app, "/b", { headers: { "accept-encoding": "gzip, deflate" } });
    expect(res.headers.get("content-encoding")).toBe("deflate");
    const gzipOnly = new Mino();
    gzipOnly.use(compress({ threshold: 8, encodings: ["deflate"] }));
    gzipOnly.get("/b", (c) => c.text(BIG));
    const skip = await fetchVia(gzipOnly, "/b", { headers: { "accept-encoding": "gzip" } });
    expect(skip.headers.get("content-encoding")).toBe(null);
  });

  it("merges vary correctly (absent / present / already-set)", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 8 }));
    app.get("/a", (c) => c.text(BIG));
    app.get("/o", () => new Response(BIG, { headers: { vary: "Origin" } }));
    app.get("/v", () => new Response(BIG, { headers: { vary: "Accept-Encoding" } }));
    const h = { "accept-encoding": "gzip" };
    expect((await fetchVia(app, "/a", { headers: h })).headers.get("vary")).toBe("Accept-Encoding");
    expect((await fetchVia(app, "/o", { headers: h })).headers.get("vary")).toBe(
      "Origin, Accept-Encoding",
    );
    expect((await fetchVia(app, "/v", { headers: h })).headers.get("vary")).toBe("Accept-Encoding");
  });

  it("skips null-body 200 and 304 without touching headers", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 1 }));
    app.get("/null", () => new Response(null, { status: 200 }));
    app.get("/nm", () => new Response(null, { status: 304 }));
    const n = await fetchVia(app, "/null", { headers: { "accept-encoding": "gzip" } });
    expect(n.status).toBe(200);
    expect(n.headers.get("content-encoding")).toBe(null);
    const s = await fetchVia(app, "/nm", { headers: { "accept-encoding": "gzip" } });
    expect(s.status).toBe(304);
    expect(s.headers.get("content-encoding")).toBe(null);
  });

  it("fast-paths small declared content-length without buffering", async () => {
    const app = new Mino();
    app.use(compress());
    app.get("/s", () => new Response("hi", { headers: { "content-length": "2" } }));
    const res = await fetchVia(app, "/s", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe(null);
    expect(await res.text()).toBe("hi");
  });

  it("erroring stream passes through without content-encoding", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 1 }));
    app.get("/err", () => {
      return new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("boom"));
          },
        }) as unknown as BodyInit,
      );
    });
    const res = await fetchVia(app, "/err", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe(null);
    await expect(res.text()).rejects.toThrow();
  });

  it("compression failure restores the original body", async () => {
    const g = globalThis as unknown as { CompressionStream?: unknown };
    const orig = g.CompressionStream;
    g.CompressionStream = undefined;
    try {
      const app = new Mino();
      app.use(compress({ threshold: 8 }));
      app.get("/b", (c) => c.text(BIG));
      const res = await fetchVia(app, "/b", { headers: { "accept-encoding": "gzip" } });
      expect(res.headers.get("content-encoding")).toBe(null);
      expect(await res.text()).toBe(BIG);
    } finally {
      g.CompressionStream = orig;
    }
  });

  it("threshold 0 still skips empty bodies", async () => {
    const app = new Mino();
    app.use(compress({ threshold: 0 }));
    app.get("/e", (c) => c.text(""));
    const res = await fetchVia(app, "/e", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-encoding")).toBe(null);
    expect(await res.text()).toBe("");
  });

  it("no downstream response passes through (stub)", async () => {
    const { stub } = stubCtx({});
    await (compress() as unknown as (c: unknown, n: () => Promise<void>) => Promise<unknown>)(
      stub,
      async () => {},
    );
  });
});

// ─── etag edges ──────────────────────────────────────────────────────────────
describe("alpha coverage: etag edges", () => {
  it("If-None-Match * always matches", async () => {
    const app = new Mino();
    app.use(etag());
    app.get("/t", (c) => c.text("hello"));
    expect((await fetchVia(app, "/t", { headers: { "if-none-match": "*" } })).status).toBe(304);
  });

  it("If-Modified-Since comparison drives 304 (valid / stale / invalid dates)", async () => {
    const app = new Mino();
    app.use(etag());
    app.get("/t", () => {
      return new Response("hello", {
        headers: { "last-modified": "Wed, 01 Jan 2020 00:00:00 GMT" },
      });
    });
    const fresh = await fetchVia(app, "/t", {
      headers: { "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT" },
    });
    expect(fresh.status).toBe(304);
    const stale = await fetchVia(app, "/t", {
      headers: { "if-modified-since": "Wed, 01 Jan 2019 00:00:00 GMT" },
    });
    expect(stale.status).toBe(200);
    const invalid = await fetchVia(app, "/t", {
      headers: { "if-modified-since": "not-a-date" },
    });
    expect(invalid.status).toBe(200);
  });

  it("notModified:false disables 304 but still sets ETag", async () => {
    const app = new Mino();
    app.use(etag({ notModified: false }));
    app.get("/t", (c) => c.text("hello"));
    const first = await fetchVia(app, "/t");
    const tag = first.headers.get("etag") ?? "";
    const second = await fetchVia(app, "/t", { headers: { "if-none-match": tag } });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("hello");
  });

  it("pre-set ETag is honored: match → 304, mismatch → untouched passthrough", async () => {
    const app = new Mino();
    app.use(etag());
    app.get("/t", () => new Response("hello", { headers: { etag: '"fixed-1"' } }));
    const hit = await fetchVia(app, "/t", { headers: { "if-none-match": '"fixed-1"' } });
    expect(hit.status).toBe(304);
    expect(hit.headers.get("etag")).toBe('"fixed-1"');
    const miss = await fetchVia(app, "/t", { headers: { "if-none-match": '"other"' } });
    expect(miss.status).toBe(200);
    expect(await miss.text()).toBe("hello");
    expect(miss.headers.get("etag")).toBe('"fixed-1"');
  });

  it("weak comparison matches strong tag against W/ request value", async () => {
    const app = new Mino();
    app.use(etag({ weak: false }));
    app.get("/t", (c) => c.text("hello"));
    const tag = (await fetchVia(app, "/t")).headers.get("etag") ?? "";
    expect(tag.startsWith("W/")).toBe(false);
    const res = await fetchVia(app, "/t", { headers: { "if-none-match": `W/${tag}` } });
    expect(res.status).toBe(304);
  });

  it("empty If-None-Match tokens never match", async () => {
    const app = new Mino();
    app.use(etag());
    app.get("/t", (c) => c.text("hello"));
    const res = await fetchVia(app, "/t", { headers: { "if-none-match": " , " } });
    expect(res.status).toBe(200);
  });

  it("skips 204 / null-body / SSE without validators", async () => {
    const app = new Mino();
    app.use(etag());
    app.get("/n", () => new Response(null, { status: 204 }));
    app.get("/z", () => new Response(null, { status: 200 }));
    app.get("/s", () => new Response("x", { headers: { "content-type": "text/event-stream" } }));
    expect((await fetchVia(app, "/n")).headers.get("etag")).toBe(null);
    expect((await fetchVia(app, "/z")).headers.get("etag")).toBe(null);
    expect((await fetchVia(app, "/s")).headers.get("etag")).toBe(null);
  });

  it("erroring stream passes through without ETag", async () => {
    const app = new Mino();
    app.use(etag());
    app.get("/err", () => {
      return new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("boom"));
          },
        }) as unknown as BodyInit,
      );
    });
    const res = await fetchVia(app, "/err");
    expect(res.headers.get("etag")).toBe(null);
  });

  it("no downstream response passes through (stub)", async () => {
    const { stub } = stubCtx({});
    await (etag() as unknown as (c: unknown, n: () => Promise<void>) => Promise<unknown>)(
      stub,
      async () => {},
    );
  });

  it("conditional(): 304-status, validator-less, and last-modified-only paths", async () => {
    const app = new Mino();
    app.use(conditional());
    app.get("/nm", () => new Response(null, { status: 304 }));
    app.get("/plain", (c) => c.text("hi"));
    app.get("/lm", () => {
      return new Response("hi", {
        headers: { "last-modified": "Wed, 01 Jan 2020 00:00:00 GMT" },
      });
    });
    expect((await fetchVia(app, "/nm")).status).toBe(304);
    expect((await fetchVia(app, "/plain")).status).toBe(200);
    const hit = await fetchVia(app, "/lm", {
      headers: { "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT" },
    });
    expect(hit.status).toBe(304);
    expect(hit.headers.get("last-modified")).toBe("Wed, 01 Jan 2020 00:00:00 GMT");
  });

  it("conditional() preserves vary/expires/cache-control on 304", async () => {
    const app = new Mino();
    app.use(conditional());
    app.get("/t", () => {
      return new Response("hello", {
        headers: {
          etag: '"v1"',
          "last-modified": "Wed, 01 Jan 2020 00:00:00 GMT",
          "cache-control": "public, max-age=60",
          vary: "Accept-Encoding",
          expires: "Wed, 01 Jan 2030 00:00:00 GMT",
        },
      });
    });
    const res = await fetchVia(app, "/t", { headers: { "if-none-match": "*" } });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("expires")).toBe("Wed, 01 Jan 2030 00:00:00 GMT");
  });
});

// ─── static edges ────────────────────────────────────────────────────────────
function richLoader(): StaticLoader {
  const enc = new TextEncoder();
  const files = new Map<
    string,
    { body: Uint8Array | string; type?: string; mtime?: Date; size?: number }
  >([
    ["index.html", { body: "<h1>home</h1>", type: "text/html; charset=utf-8" }],
    ["docs/index.html", { body: "<h1>docs</h1>" }],
    [".hidden", { body: enc.encode("shh") }],
    ["str.txt", { body: "plain string body" }],
    ["sized.bin", { body: enc.encode("0123456789"), size: 10 }],
    ["noext", { body: enc.encode("raw") }],
    ["weird.blah", { body: enc.encode("weird") }],
    ["old.txt", { body: enc.encode("old"), mtime: new Date("2020-01-01T00:00:00Z") }],
  ]);
  return {
    load: async (p: string) => {
      if (p === "boom.txt") throw new Error("disk gone");
      return files.get(p);
    },
  };
}

describe("alpha coverage: static edges", () => {
  it("non-GET/HEAD and off-prefix requests pass to next()", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: richLoader() }));
    app.post("/static/index.html", (c) => c.text("posted"));
    app.get("/other", (c) => c.text("other"));
    expect(await (await fetchVia(app, "/static/index.html", { method: "POST" })).text()).toBe(
      "posted",
    );
    expect(await (await fetchVia(app, "/other")).text()).toBe("other");
  });

  it("malformed path input returns 400 JSON (stubs)", async () => {
    for (const path of ["/static/%", "/static/%zz"]) {
      const handler = serveStatic({ loader: richLoader() });
      let stored: Response | undefined;
      const stub = {
        method: "GET",
        get path(): string {
          return path;
        },
        header: (_n: string) => undefined,
        setResponse: (r: Response) => {
          stored = r;
        },
      };
      await (handler as unknown as (c: unknown, n: () => Promise<void>) => Promise<unknown>)(
        stub,
        async () => {},
      );
      expect(stored?.status).toBe(400);
    }
    // c.path itself throwing → 400
    const handler = serveStatic({ loader: richLoader() });
    let stored: Response | undefined;
    const throwing = {
      method: "GET",
      get path(): string {
        throw new Error("bad url");
      },
      header: (_n: string) => undefined,
      setResponse: (r: Response) => {
        stored = r;
      },
    };
    await (handler as unknown as (c: unknown, n: () => Promise<void>) => Promise<unknown>)(
      throwing,
      async () => {},
    );
    expect(stored?.status).toBe(400);
  });

  it("backslash paths are forbidden (stub)", async () => {
    const handler = serveStatic({ loader: richLoader() });
    let stored: Response | undefined;
    const stub = {
      method: "GET",
      path: "/static/a\\b",
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

  it("normalizeStaticPath resolves dots and refuses escapes", () => {
    expect(normalizeStaticPath("/a/b/../c")).toBe("/a/c");
    expect(normalizeStaticPath("/a/./b")).toBe("/a/b");
    expect(normalizeStaticPath("/a/b/")).toBe("/a/b");
    expect(normalizeStaticPath("/")).toBe("/");
    expect(normalizeStaticPath("")).toBe("/");
  });

  it("directory root without index → 404; with index → index.html", async () => {
    const plain = new Mino();
    plain.use(serveStatic({ loader: richLoader() }));
    expect((await fetchVia(plain, "/static/")).status).toBe(404);
    const indexed = new Mino();
    indexed.use(serveStatic({ loader: richLoader(), index: true }));
    const root = await fetchVia(indexed, "/static/");
    expect(root.status).toBe(200);
    expect(await root.text()).toBe("<h1>home</h1>");
    const sub = await fetchVia(indexed, "/static/docs/");
    expect(sub.status).toBe(200);
    expect(await sub.text()).toBe("<h1>docs</h1>");
  });

  it("dotfiles ignore → 404, allow → served", async () => {
    const ignore = new Mino();
    ignore.use(serveStatic({ loader: richLoader(), dotfiles: "ignore" }));
    expect((await fetchVia(ignore, "/static/.hidden")).status).toBe(404);
    const allow = new Mino();
    allow.use(serveStatic({ loader: richLoader(), dotfiles: "allow" }));
    const res = await fetchVia(allow, "/static/.hidden");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("shh");
  });

  it("loader throw maps to 404 JSON", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: richLoader() }));
    const res = await fetchVia(app, "/static/boom.txt");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ status: 404 });
  });

  it("string bodies, explicit sizes, extension fallbacks", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: richLoader() }));
    const str = await fetchVia(app, "/static/str.txt");
    expect(str.headers.get("content-length")).toBe(String("plain string body".length));
    expect(str.headers.get("etag")).toMatch(/^W\//);
    expect(await str.text()).toBe("plain string body");
    const sized = await fetchVia(app, "/static/sized.bin");
    expect(sized.headers.get("content-length")).toBe("10");
    expect((await fetchVia(app, "/static/noext")).headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect((await fetchVia(app, "/static/weird.blah")).headers.get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("stream bodies serve without ETag", async () => {
    const loader: StaticLoader = {
      load: async (p: string) =>
        p === "live.bin"
          ? {
              body: new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode("chunk"));
                  c.close();
                },
              }) as unknown as BodyInit,
              type: "application/octet-stream",
            }
          : undefined,
    };
    const app = new Mino();
    app.use(serveStatic({ loader }));
    const res = await fetchVia(app, "/static/live.bin");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(null);
    expect(await res.text()).toBe("chunk");
  });

  it("If-Modified-Since drives static 304; bad dates and missing mtime pass", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: richLoader() }));
    const hit = await fetchVia(app, "/static/old.txt", {
      headers: { "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT" },
    });
    expect(hit.status).toBe(304);
    const bad = await fetchVia(app, "/static/old.txt", {
      headers: { "if-modified-since": "garbage" },
    });
    expect(bad.status).toBe(200);
    const noMtime = await fetchVia(app, "/static/str.txt", {
      headers: { "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT" },
    });
    expect(noMtime.status).toBe(200);
    const star = await fetchVia(app, "/static/old.txt", {
      headers: { "if-none-match": "*" },
    });
    expect(star.status).toBe(304);
  });

  it("HEAD serves headers with empty body", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: richLoader() }));
    const res = await app.fetch(new Request("http://localhost/static/str.txt", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(await res.text()).toBe("");
  });

  it("respects custom prefix and maxAge", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: richLoader(), prefix: "/assets", maxAgeSec: 60 }));
    const res = await fetchVia(app, "/assets/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });
});
