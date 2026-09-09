import { describe, expect, it, vi, afterEach } from "vitest";
import { Mino } from "../src/mino.js";
import { cors } from "../src/cors.js";
import { helmet } from "../src/helmet.js";
import { clientIp, rateLimit } from "../src/rate-limit.js";
import { REQUEST_ID_STATE_KEY, logger, requestId } from "../src/request-id.js";
import type { AccessLogEntry } from "../src/request-id.js";
import { createSSEStream, formatSSE } from "../src/sse.js";
import { createClient, hc } from "../src/client.js";
import type { Context } from "../src/context.js";

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── CORS ───

describe("branches-c: cors", () => {
  it("non-OPTIONS requests without Origin pass through untouched", async () => {
    const app = new Mino();
    app.use(cors({ origin: "https://a.test" }));
    app.post("/", (c) => c.text("posted"));
    const res = await fetchVia(app, "/", { method: "POST", body: "x" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("posted");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("string allowlist allows exact match, rejects others", async () => {
    const app = new Mino();
    app.use(cors({ origin: "https://a.test" }));
    app.get("/", (c) => c.text("ok"));
    const good = await fetchVia(app, "/", { headers: { origin: "https://a.test" } });
    expect(good.headers.get("access-control-allow-origin")).toBe("https://a.test");
    const bad = await fetchVia(app, "/", { headers: { origin: "https://b.test" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    expect(await bad.text()).toBe("ok");
  });

  it("direct RegExp rule and function rule gate origins", async () => {
    const re = new Mino();
    re.use(cors({ origin: /^https:\/\/.*\.example\.com$/g }));
    re.get("/", (c) => c.text("ok"));
    // Twice: global regex lastIndex must reset or the 2nd call would fail.
    for (let i = 0; i < 2; i++) {
      const good = await fetchVia(re, "/", { headers: { origin: "https://x.example.com" } });
      expect(good.headers.get("access-control-allow-origin")).toBe("https://x.example.com");
    }
    const bad = await fetchVia(re, "/", { headers: { origin: "https://evil.test" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();

    const fn = new Mino();
    fn.use(cors({ origin: (o) => o.endsWith(".allowed.test") }));
    fn.get("/", (c) => c.text("ok"));
    expect(
      (await fetchVia(fn, "/", { headers: { origin: "https://a.allowed.test" } })).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("https://a.allowed.test");
    expect(
      (await fetchVia(fn, "/", { headers: { origin: "https://a.denied.test" } })).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
  });

  it("array allowlist mixes strings and RegExp", async () => {
    const app = new Mino();
    app.use(cors({ origin: ["https://exact.test", /^https:\/\/.*\.wild\.test$/] }));
    app.get("/", (c) => c.text("ok"));
    expect(
      (await fetchVia(app, "/", { headers: { origin: "https://exact.test" } })).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("https://exact.test");
    expect(
      (await fetchVia(app, "/", { headers: { origin: "https://a.wild.test" } })).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("https://a.wild.test");
    expect(
      (await fetchVia(app, "/", { headers: { origin: "https://nope.test" } })).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
  });

  it("default/false origin rule allows no origin", async () => {
    for (const opts of [undefined, { origin: false as const }]) {
      const app = new Mino();
      app.use(cors(opts));
      app.get("/", (c) => c.text("ok"));
      const res = await fetchVia(app, "/", { headers: { origin: "https://a.test" } });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(await res.text()).toBe("ok");
    }
  });

  it("credentials mode echoes origin (never *) on simple and preflight", async () => {
    const app = new Mino();
    app.use(cors({ origin: true, credentials: true }));
    app.get("/", (c) => c.text("ok"));
    const simple = await fetchVia(app, "/", { headers: { origin: "https://any.test" } });
    expect(simple.headers.get("access-control-allow-origin")).toBe("https://any.test");
    expect(simple.headers.get("access-control-allow-credentials")).toBe("true");

    const pre = await fetchVia(app, "/", {
      method: "OPTIONS",
      headers: { origin: "https://any.test", "access-control-request-method": "GET" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://any.test");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");

    // credentials off: no allow-credentials header even when reflecting
    const plain = new Mino();
    plain.use(cors({ origin: true }));
    plain.get("/", (c) => c.text("ok"));
    const r = await fetchVia(plain, "/", { headers: { origin: "https://any.test" } });
    expect(r.headers.get("access-control-allow-origin")).toBe("https://any.test");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("preflight honors explicit allowedHeaders/methods/maxAge over reflection", async () => {
    const app = new Mino();
    app.use(
      cors({
        origin: "https://a.test",
        allowedHeaders: ["x-custom"],
        methods: ["GET", "POST"],
        maxAge: 60,
      }),
    );
    app.get("/", (c) => c.text("ok"));
    const res = await fetchVia(app, "/", {
      method: "OPTIONS",
      headers: {
        origin: "https://a.test",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "x-other, authorization",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("x-custom");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(res.headers.get("access-control-max-age")).toBe("60");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("preflight reflects request headers when allowedHeaders unset, omits when absent", async () => {
    const app = new Mino();
    app.use(cors({ origin: true }));
    app.get("/", (c) => c.text("ok"));
    const reflected = await fetchVia(app, "/", {
      method: "OPTIONS",
      headers: {
        origin: "https://a.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-a",
      },
    });
    expect(reflected.headers.get("access-control-allow-headers")).toBe("x-a");
    expect(reflected.headers.get("access-control-max-age")).toBeNull();
    const bare = await fetchVia(app, "/", {
      method: "OPTIONS",
      headers: { origin: "https://a.test", "access-control-request-method": "GET" },
    });
    expect(bare.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("disallowed preflight gets 204 with Vary only", async () => {
    const app = new Mino();
    let routed = false;
    app.use(cors({ origin: ["https://a.test"] }));
    app.get("/", (c) => {
      routed = true;
      return c.text("ok");
    });
    const res = await fetchVia(app, "/", {
      method: "OPTIONS",
      headers: { origin: "https://evil.test", "access-control-request-method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
    expect(routed).toBe(false);
  });

  it("OPTIONS without preflight headers passes through, preserving Allow + CORS headers", async () => {
    const app = new Mino();
    app.use(cors({ origin: true }));
    app.get("/only-get", (c) => c.text("get"));
    const res = await app.fetch(
      new Request("http://localhost/only-get", {
        method: "OPTIONS",
        headers: { origin: "https://x.test" },
      }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://x.test");
  });

  it("simple responses expose headers and merge with pre-existing Vary", async () => {
    const app = new Mino();
    app.use(cors({ origin: true, exposedHeaders: ["x-total"] }));
    app.get("/", (c) => {
      c.headerSet("vary", "Accept-Encoding");
      return c.text("ok");
    });
    const res = await fetchVia(app, "/", { headers: { origin: "https://a.test" } });
    expect(res.headers.get("access-control-expose-headers")).toBe("x-total");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(res.headers.get("vary")).toContain("Origin");
  });
});

// ─── Helmet ───

describe("branches-c: helmet", () => {
  it("custom HSTS options render exactly; hsts:false disables even on https", async () => {
    const app = new Mino();
    app.use(helmet({ hsts: { maxAge: 60, includeSubDomains: false, preload: true } }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.fetch(new Request("https://localhost/"));
    expect(res.headers.get("strict-transport-security")).toBe("max-age=60; preload");

    const off = new Mino();
    off.use(helmet({ hsts: false }));
    off.get("/", (c) => c.text("ok"));
    expect(
      (await off.fetch(new Request("https://localhost/"))).headers.get("strict-transport-security"),
    ).toBeNull();
  });

  it("every default header is overridable or disableable", async () => {
    const app = new Mino();
    app.use(
      helmet({
        contentTypeOptions: false,
        frameGuard: "DENY",
        referrerPolicy: "same-origin",
        dnsPrefetchControl: false,
        hsts: false,
        contentSecurityPolicy: "default-src 'none'",
      }),
    );
    app.get("/", (c) => c.text("ok"));
    const res = await fetchVia(app, "/");
    expect(res.headers.get("x-content-type-options")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-dns-prefetch-control")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("referrerPolicy:false disables; explicit route HSTS wins", async () => {
    const app = new Mino();
    app.use(helmet({ referrerPolicy: false }));
    app.get("/", (c) => {
      c.headerSet("strict-transport-security", "max-age=1");
      return c.text("ok");
    });
    const res = await app.fetch(new Request("https://localhost/"));
    expect(res.headers.get("referrer-policy")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBe("max-age=1");
  });

  it("unparseable URL skips HSTS but still sets other headers", async () => {
    const store: { res?: Response } = { res: new Response("ok") };
    const evil = {
      get url(): URL {
        throw new Error("bad url");
      },
      get res() {
        return store.res;
      },
      setResponse(r: Response) {
        store.res = r;
      },
    };
    const out = (await helmet()(evil as unknown as Context, async () => {})) as Response;
    expect(out.headers.get("strict-transport-security")).toBeNull();
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("no downstream response resolves without throwing", async () => {
    const bare = { res: undefined };
    const out = await helmet()(bare as unknown as Context, async () => {});
    expect(out).toBeUndefined();
  });
});

// ─── Rate limit ───

describe("branches-c: rate-limit", () => {
  it("allows max then 429s with matching Retry-After/reset and JSON shape", async () => {
    const app = new Mino();
    app.use(rateLimit({ windowMs: 60_000, max: 2 }));
    app.get("/", (c) => c.text("ok"));
    const first = await fetchVia(app, "/");
    expect(first.status).toBe(200);
    expect(first.headers.get("ratelimit-limit")).toBe("2");
    expect(first.headers.get("ratelimit-remaining")).toBe("1");
    expect((await fetchVia(app, "/")).status).toBe(200);
    const limited = await fetchVia(app, "/");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    expect(limited.headers.get("ratelimit-limit")).toBe("2");
    expect(limited.headers.get("retry-after")).toBe(limited.headers.get("ratelimit-reset"));
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(0);
    expect(await limited.json()).toMatchObject({ status: 429, code: "too_many_requests" });
  });

  it("headers:false emits no RateLimit/Retry-After headers on success or 429", async () => {
    const app = new Mino();
    app.use(rateLimit({ windowMs: 60_000, max: 1, headers: false }));
    app.get("/", (c) => c.text("ok"));
    const ok = await fetchVia(app, "/");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("ratelimit-limit")).toBeNull();
    const limited = await fetchVia(app, "/");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeNull();
    expect(limited.headers.get("ratelimit-limit")).toBeNull();
    expect(await limited.json()).toMatchObject({ code: "too_many_requests" });
  });

  it("window expiry resets the bucket", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const app = new Mino();
      app.use(rateLimit({ windowMs: 1000, max: 1 }));
      app.get("/", (c) => c.text("ok"));
      expect((await fetchVia(app, "/")).status).toBe(200);
      expect((await fetchVia(app, "/")).status).toBe(429);
      now += 1500;
      expect((await fetchVia(app, "/")).status).toBe(200);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("trustProxy isolates clients; untrusted XFF stays in one bucket", async () => {
    const trusted = new Mino();
    trusted.use(rateLimit({ windowMs: 60_000, max: 1, trustProxy: 1 }));
    trusted.get("/", (c) => c.text("ok"));
    expect(
      (await fetchVia(trusted, "/", { headers: { "x-forwarded-for": "client-a, proxy" } })).status,
    ).toBe(200);
    expect(
      (await fetchVia(trusted, "/", { headers: { "x-forwarded-for": "client-b, proxy" } })).status,
    ).toBe(200);
    expect(
      (await fetchVia(trusted, "/", { headers: { "x-forwarded-for": "client-a, proxy" } })).status,
    ).toBe(429);

    const bare = new Mino();
    bare.use(rateLimit({ windowMs: 60_000, max: 1 }));
    bare.get("/", (c) => c.text("ok"));
    expect((await fetchVia(bare, "/")).status).toBe(200);
    expect(
      (await fetchVia(bare, "/", { headers: { "x-forwarded-for": "someone-else" } })).status,
    ).toBe(429);
  });

  it("clientIp normalizes whitespace/empty XFF entries and honors peer fallback", () => {
    const ctx = (headers: Record<string, string>) =>
      ({ header: (n: string) => headers[n.toLowerCase()] }) as unknown as Context;
    // trustProxy:true trims the leftmost entry and ignores the server peer
    expect(
      clientIp(ctx({ "x-mino-peer": "10.0.0.1", "x-forwarded-for": "  9.9.9.9 , p1 " }), true),
    ).toBe("9.9.9.9");
    // trustProxy:true without XFF falls back to peer
    expect(clientIp(ctx({ "x-mino-peer": "2.2.2.2" }), true)).toBe("2.2.2.2");
    // numeric trust drops N hops while filtering empties
    expect(clientIp(ctx({ "x-forwarded-for": "client, , p1" }), 1)).toBe("client");
    // numeric trust without XFF falls back to peer
    expect(clientIp(ctx({ "x-mino-peer": "1.1.1.1" }), 2)).toBe("1.1.1.1");
    // blank/empty-only XFF yields no IP → peer → global
    expect(clientIp(ctx({ "x-forwarded-for": "   " }), true)).toBe("global");
    expect(clientIp(ctx({ "x-forwarded-for": ", ," }), 1)).toBe("global");
    expect(clientIp(ctx({}), 3)).toBe("global");
  });

  it("bucket prune survives >MAX_BUCKETS keys with live windows", async () => {
    let i = 0;
    const h = rateLimit({ windowMs: 60_000, max: 1_000_000, key: () => `prune-live-${i++}` });
    for (let k = 0; k < 10_150; k++) {
      const store: { res?: Response } = {};
      const c = {
        header: () => undefined,
        get res() {
          return store.res;
        },
        setResponse(r: Response) {
          store.res = r;
        },
      };
      await (h as unknown as (c: unknown, next: () => Promise<void>) => Promise<unknown>)(
        c,
        async () => {
          store.res = new Response("ok");
        },
      );
    }
    const store: { res?: Response } = {};
    const c = {
      header: () => undefined,
      get res() {
        return store.res;
      },
      setResponse(r: Response) {
        store.res = r;
      },
    };
    await (h as unknown as (c: unknown, next: () => Promise<void>) => Promise<unknown>)(
      c,
      async () => {
        store.res = new Response("ok");
      },
    );
    expect(store.res?.status).toBe(200);
    expect(store.res?.headers.get("ratelimit-remaining")).not.toBeNull();
  });

  it("bucket prune reclaims expired windows past MAX_BUCKETS", async () => {
    let i = 0;
    const h = rateLimit({ windowMs: 0, max: 5, key: () => `prune-expired-${i++}` });
    for (let k = 0; k < 10_150; k++) {
      const store: { res?: Response } = {};
      const c = {
        header: () => undefined,
        get res() {
          return store.res;
        },
        setResponse(r: Response) {
          store.res = r;
        },
      };
      await (h as unknown as (c: unknown, next: () => Promise<void>) => Promise<unknown>)(
        c,
        async () => {
          store.res = new Response("ok");
        },
      );
    }
    // windowMs:0 → every window already expired → never limited
    const store: { res?: Response } = {};
    const c = {
      header: () => undefined,
      get res() {
        return store.res;
      },
      setResponse(r: Response) {
        store.res = r;
      },
    };
    await (h as unknown as (c: unknown, next: () => Promise<void>) => Promise<unknown>)(
      c,
      async () => {
        store.res = new Response("ok");
      },
    );
    expect(store.res?.status).toBe(200);
  });
});

// ─── Request ID + logger ───

describe("branches-c: request-id", () => {
  it("propagates valid incoming IDs and regenerates hostile/overlong ones", async () => {
    const app = new Mino();
    app.use(requestId());
    app.get("/", (c) => c.text(String(c.get(REQUEST_ID_STATE_KEY))));
    const echo = await fetchVia(app, "/", { headers: { "x-request-id": "req-123_ok~test:1" } });
    expect(echo.headers.get("x-request-id")).toBe("req-123_ok~test:1");
    expect(await echo.text()).toBe("req-123_ok~test:1");

    const spaced = await fetchVia(app, "/", { headers: { "x-request-id": "has space" } });
    const regen = spaced.headers.get("x-request-id") ?? "";
    expect(regen).not.toBe("has space");
    expect(regen.length).toBeGreaterThan(8);

    const long = await fetchVia(app, "/", { headers: { "x-request-id": `x${"y".repeat(200)}` } });
    expect((long.headers.get("x-request-id") ?? "").length).toBeLessThanOrEqual(128);
  });

  it("falls back to Math.random IDs when crypto.randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const app = new Mino();
      app.use(requestId());
      app.get("/", (c) => c.text(String(c.get(REQUEST_ID_STATE_KEY))));
      const res = await fetchVia(app, "/");
      const id = res.headers.get("x-request-id") ?? "";
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await res.text()).toBe(id);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("custom header + expose:false sets state without echoing", async () => {
    const app = new Mino();
    app.use(requestId({ header: "x-corr", expose: false }));
    app.get("/", (c) => c.text(String(c.get(REQUEST_ID_STATE_KEY))));
    const res = await fetchVia(app, "/", { headers: { "x-corr": "corr-9" } });
    expect(res.headers.get("x-corr")).toBeNull();
    expect(await res.text()).toBe("corr-9");
  });

  it("pre-set response IDs win over generated ones", async () => {
    const app = new Mino();
    app.use(requestId());
    app.get("/", (c) => {
      c.headerSet("x-request-id", "preset");
      return c.text("ok");
    });
    expect((await fetchVia(app, "/")).headers.get("x-request-id")).toBe("preset");
  });

  it("logger never logs bodies/issues verbatim and redacts hostile IDs", async () => {
    const seen: AccessLogEntry[] = [];
    const app = new Mino();
    app.use(requestId(), logger({ log: (e) => seen.push(e) }));
    app.post("/echo", async (c) => c.json(await c.jsonBody()));
    app.get("/whoami", (c) => c.text(String(c.get(REQUEST_ID_STATE_KEY))));
    await app.fetch(
      new Request("http://localhost/echo", {
        method: "POST",
        body: JSON.stringify({ secret: "s3cr3t", issues: [{ message: "boom" }] }),
        headers: { "content-type": "application/json", "x-request-id": "good-id-1" },
      }),
    );
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/echo",
      status: 200,
      requestId: "good-id-1",
    });
    expect(Object.keys(seen[0] as unknown as Record<string, unknown>).sort()).toEqual([
      "method",
      "ms",
      "path",
      "requestId",
      "route",
      "status",
      "time",
    ]);
    const line = JSON.stringify(seen[0]);
    expect(line).not.toContain("s3cr3t");
    expect(line).not.toContain("boom");

    // Hostile ID arrives via adapter bypass (undici would reject CRLF at construction).
    const hostile = "evil\r\nInjected: 1";
    const evilReq = {
      url: "http://localhost/whoami",
      method: "GET",
      headers: { get: (n: string) => (n.toLowerCase() === "x-request-id" ? hostile : null) },
    } as unknown as Request;
    const evilRes = await app.fetch(evilReq);
    const echoed = evilRes.headers.get("x-request-id") ?? "";
    expect(echoed).not.toContain("\r");
    expect(echoed).not.toBe(hostile);
    const logged = seen[seen.length - 1] as AccessLogEntry;
    expect(logged.requestId).toBe(echoed);
    expect(JSON.stringify(logged)).not.toContain("\r");
  });

  it("logger tolerates unparseable URLs and missing responses", async () => {
    const seen: AccessLogEntry[] = [];
    const h = logger({ log: (e) => seen.push(e) });
    const fake = {
      get path(): string {
        throw new Error("bad url");
      },
      method: "GET",
      routePath: undefined,
      res: undefined,
      get: () => undefined,
      header: () => undefined,
    };
    await h(fake as unknown as Context, async () => {});
    expect(seen[0]).toMatchObject({ path: "-", status: 500 });

    // logger without requestId middleware falls back to the incoming header
    const seen2: AccessLogEntry[] = [];
    const h2 = logger({ log: (e) => seen2.push(e) });
    const app = new Mino();
    app.use(h2);
    app.get("/", (c) => c.text("ok"));
    await fetchVia(app, "/", { headers: { "x-request-id": "hdr-only" } });
    expect(seen2[0]?.requestId).toBe("hdr-only");
  });
});

// ─── SSE ───

describe("branches-c: sse", () => {
  it("formats id/event/retry/multi-line data exactly", () => {
    expect(formatSSE({ data: "a\nb", event: "msg", id: "1", retry: 5 })).toBe(
      "id: 1\nevent: msg\nretry: 5\ndata: a\ndata: b\n\n",
    );
    expect(formatSSE({ data: "" })).toBe("data: \n\n");
    expect(formatSSE({ data: "x\ny\nz" })).toBe("data: x\ndata: y\ndata: z\n\n");
  });

  it("streams iterables and function sources, then closes", async () => {
    async function* gen() {
      yield { data: "one" };
      yield { data: "two\nlines", event: "e" };
    }
    for (const source of [gen(), () => gen()]) {
      const reader = createSSEStream(source as AsyncIterable<{ data: string }>).getReader();
      const chunks: string[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      expect(chunks.join("")).toBe("data: one\n\n" + "event: e\ndata: two\ndata: lines\n\n");
    }
  });

  it("surfaces source errors to the reader", async () => {
    async function* boom(): AsyncGenerator<{ data: string }> {
      yield { data: "a" };
      throw new Error("boom");
    }
    const reader = createSSEStream(boom()).getReader();
    const first = await reader.read();
    expect(first.value).toContain("data: a");
    await expect(reader.read()).rejects.toThrow("boom");
  });

  it("applies backpressure for fast producers instead of buffering unboundedly", async () => {
    async function* many(): AsyncGenerator<{ data: string }> {
      for (let i = 0; i < 20; i++) yield { data: `m${i}` };
    }
    const stream = createSSEStream(many());
    // Let the producer run ahead so desiredSize drops to <= 0 (1ms waits).
    await new Promise((r) => setTimeout(r, 25));
    const reader = stream.getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks.length).toBe(20);
    expect(chunks.join("")).toContain("data: m19");
  });
});

// ─── Client ───

describe("branches-c: client", () => {
  function stubClient(baseUrl = "http://localhost:3000///") {
    let lastUrl = "";
    let lastInit: RequestInit & { headers?: Headers } = {};
    const fetchStub = async (url: string | URL, init?: RequestInit) => {
      lastUrl = String(url);
      lastInit = (init ?? {}) as RequestInit & { headers?: Headers };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createClient(baseUrl, {
      fetch: fetchStub as unknown as typeof fetch,
      headers: { "x-app": "1" },
    });
    return { client, last: () => ({ url: lastUrl, init: lastInit }) };
  }

  it("$get builds params + array/single query with slash normalization", async () => {
    const { client, last } = stubClient();
    const users = (
      client as unknown as Record<
        string,
        Record<string, { $get: (o: unknown) => Promise<Response> }>
      >
    ).users as Record<string, { $get: (o: unknown) => Promise<Response> }>;
    const res = await (users[":id"] as { $get: (o: unknown) => Promise<Response> }).$get({
      param: { id: "a b" },
      query: { tag: ["x", "y"], q: "hi" },
    });
    expect(res.status).toBe(200);
    expect(last().url).toBe("http://localhost:3000/users/a%20b?tag=x&tag=y&q=hi");
    expect(last().init.headers).toBeInstanceOf(Headers);
  });

  it("$post sends JSON; $put/$delete/$patch use their methods; form encodes", async () => {
    const { client, last } = stubClient();
    const anyClient = client as unknown as Record<
      string,
      { $post: (o: unknown) => Promise<Response> }
    >;
    const echo = anyClient.echo as { $post: (o: unknown) => Promise<Response> };
    await echo.$post({ json: { a: 1 }, header: { "x-req": "yes" } });
    expect(last().init.method).toBe("POST");
    expect((last().init.headers as Headers).get("content-type")).toBe("application/json");
    expect((last().init.headers as Headers).get("x-app")).toBe("1");
    expect((last().init.headers as Headers).get("x-req")).toBe("yes");
    expect(last().init.body).toBe(JSON.stringify({ a: 1 }));

    const verbs = client as unknown as Record<
      string,
      {
        $put: (o: unknown) => Promise<Response>;
        $delete: () => Promise<Response>;
        $patch: (o: unknown) => Promise<Response>;
      }
    >;
    const item = verbs.item as {
      $put: (o: unknown) => Promise<Response>;
      $delete: () => Promise<Response>;
      $patch: (o: unknown) => Promise<Response>;
    };
    await item.$put({ json: { b: 2 } });
    expect(last().init.method).toBe("PUT");
    await item.$delete();
    expect(last().init.method).toBe("DELETE");
    await item.$patch({ json: { c: 3 } });
    expect(last().init.method).toBe("PATCH");

    const form = anyClient.form as { $post: (o: unknown) => Promise<Response> };
    await form.$post({ form: { a: "1" } });
    expect((last().init.headers as Headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(last().init.body).toBe("a=1");
  });

  it("GET/HEAD drop bodies; $fetch defaults GET and honors method + fetch opts", async () => {
    const { client, last } = stubClient();
    const anyClient = client as unknown as Record<
      string,
      { $get: (o: unknown) => Promise<Response>; $fetch: (o: unknown) => Promise<Response> }
    >;
    const users = anyClient.users as {
      $get: (o: unknown) => Promise<Response>;
      $fetch: (o: unknown) => Promise<Response>;
    };
    await users.$get({ json: { a: 1 } });
    expect(last().init.method).toBe("GET");
    expect(last().init.body).toBeUndefined();

    await users.$fetch({ method: "HEAD", json: { a: 1 } });
    expect(last().init.method).toBe("HEAD");
    expect(last().init.body).toBeUndefined();

    await users.$fetch({
      method: "DELETE",
      json: { a: 1 },
      fetch: { credentials: "include" },
    });
    expect(last().init.method).toBe("DELETE");
    expect(last().init.body).toBe(JSON.stringify({ a: 1 }));
    expect(last().init.credentials).toBe("include");

    const def = await users.$fetch({});
    expect(def.status).toBe(200);
    expect(last().init.method).toBe("GET");
  });

  it("passes error statuses through without throwing; fetch faults reject", async () => {
    const passthrough = createClient("http://x.test", {
      fetch: (async () => new Response("missing", { status: 404 })) as unknown as typeof fetch,
    });
    const thing = (passthrough as unknown as Record<string, { $get: () => Promise<Response> }>)
      .thing as { $get: () => Promise<Response> };
    const r404 = await thing.$get();
    expect(r404.status).toBe(404);
    expect(await r404.text()).toBe("missing");

    const faulty = createClient("http://x.test", {
      fetch: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    await expect(
      (
        (faulty as unknown as Record<string, unknown>).thing as {
          $get: () => Promise<Response>;
        }
      ).$get(),
    ).rejects.toThrow("down");
  });

  it("unknown $/underscore/symbol props resolve to undefined, never hang", async () => {
    const { client } = stubClient();
    const anyClient = client as unknown as Record<string | symbol, unknown>;
    expect(anyClient.$bogus).toBeUndefined();
    expect(anyClient._hidden).toBeUndefined();
    expect(anyClient[Symbol("x")]).toBeUndefined();
    expect(anyClient.then).toBeUndefined();
    expect(anyClient.catch).toBeUndefined();
    expect(anyClient.finally).toBeUndefined();
    await expect(Promise.resolve(client)).resolves.toBe(client);
  });

  it("hc alias builds working clients against a live app graph", async () => {
    const app = new Mino();
    app.get("/hello", (c) => c.json({ msg: "hi" }));
    const hcClient = hc("http://localhost", {
      fetch: ((url: string | URL, init?: RequestInit) =>
        app.fetch(new Request(url, init))) as unknown as typeof fetch,
    });
    const hello = (hcClient as unknown as Record<string, unknown>).hello as {
      $get: () => Promise<Response>;
    };
    const res = await hello.$get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: "hi" });
  });
});
