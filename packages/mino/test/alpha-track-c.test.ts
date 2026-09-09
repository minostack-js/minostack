/**
 * alpha-track-c: proxy/combine, under-pressure, websocket codec.
 * Hermetic — upstream is a local `node:http` echo server on 127.0.0.1:0,
 * everything else is in-process. No external network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Mino } from "../src/mino.js";
import { proxy, combine } from "../src/proxy.js";
import { underPressure, createPressureMonitor } from "../src/under-pressure.js";
import {
  WEBSOCKET_GUID,
  Opcode,
  isWebSocketRequest,
  createAcceptKey,
  encodeFrame,
  createFrameParser,
  websocketUpgradeResponse,
} from "../src/websocket.js";
import type { WsFrame } from "../src/websocket.js";

// ─────────────────────────────────────────────────────────────────
// Echo upstream (node:http, ephemeral port)
// ─────────────────────────────────────────────────────────────────

let server: Server;
let port = 0;

function echoHeaders(req: import("node:http").IncomingMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://internal");
      // Prefix match: proxy string targets join onto the incoming path.
      if (url.pathname === "/hang" || url.pathname.startsWith("/hang/")) return; // never respond — timeout tests
      if (url.pathname === "/teapot" || url.pathname.startsWith("/teapot/")) {
        res.writeHead(418, { "content-type": "text/plain" });
        res.end("teapot");
        return;
      }
      if (url.pathname === "/cookies" || url.pathname.startsWith("/cookies/")) {
        res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          path: url.pathname,
          query: url.search,
          headers: echoHeaders(req),
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "object" && addr !== null) port = addr.port;
  expect(port).toBeGreaterThan(0);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

const upstream = (): string => `http://127.0.0.1:${port}`;

interface EchoBody {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
}

function proxyApp(
  target: string | ((req: Request) => string | Promise<string>),
  opts?: {
    headers?: HeadersInit | ((o: Headers) => void);
    rewrite?: (u: URL) => void;
    timeoutMs?: number;
  },
): Mino {
  const app = new Mino();
  app.all("/proxy/*", proxy(target, opts));
  return app;
}

async function echoOf(res: Response): Promise<EchoBody> {
  expect(res.status).toBe(201);
  return (await res.json()) as EchoBody;
}

// ─────────────────────────────────────────────────────────────────
// proxy
// ─────────────────────────────────────────────────────────────────

describe("track-c proxy", () => {
  it("forwards method, path, query and streams the body; preserves status", async () => {
    const app = proxyApp(upstream());
    const res = await app.fetch(
      new Request("http://localhost/proxy/echo?a=b", { method: "POST", body: "hello-upstream" }),
    );
    const echo = await echoOf(res);
    expect(echo.method).toBe("POST");
    expect(echo.path).toBe("/proxy/echo");
    expect(echo.query).toBe("?a=b");
    expect(echo.body).toBe("hello-upstream");
  });

  it("strips hop-by-hop headers, forwards auth + custom headers", async () => {
    const app = proxyApp(upstream());
    const res = await app.fetch(
      new Request("http://localhost/proxy/echo", {
        headers: {
          connection: "close",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          upgrade: "websocket",
          trailer: "x-checksum",
          te: "trailers",
          "proxy-authorization": "secret",
          "proxy-connection": "keep-alive",
          authorization: "Bearer token123",
          "x-keep": "yes",
        },
      }),
    );
    // upgrade would make global fetch throw — a 201 proves we stripped it.
    const echo = await echoOf(res);
    expect(echo.headers["connection"]).not.toBe("close");
    expect(echo.headers["keep-alive"]).toBeUndefined();
    expect(echo.headers["transfer-encoding"]).toBeUndefined();
    expect(echo.headers["upgrade"]).toBeUndefined();
    expect(echo.headers["trailer"]).toBeUndefined();
    expect(echo.headers["te"]).toBeUndefined();
    expect(echo.headers["proxy-authorization"]).toBeUndefined();
    expect(echo.headers["proxy-connection"]).toBeUndefined();
    expect(echo.headers["authorization"]).toBe("Bearer token123");
    expect(echo.headers["x-keep"]).toBe("yes");
  });

  it("strips headers named in the incoming Connection list", async () => {
    const app = proxyApp(upstream());
    const res = await app.fetch(
      new Request("http://localhost/proxy/echo", {
        headers: { connection: "x-strip-me, ,", "x-strip-me": "gone", "x-keep": "yes" },
      }),
    );
    const echo = await echoOf(res);
    expect(echo.headers["x-strip-me"]).toBeUndefined();
    expect(echo.headers["x-keep"]).toBe("yes");
  });

  it("appends x-mino-peer to x-forwarded-for; sets proto + host", async () => {
    const app = proxyApp(upstream());
    const res = await app.fetch(
      new Request("http://localhost/proxy/echo", {
        headers: { "x-mino-peer": "9.9.9.9", "x-forwarded-for": "1.1.1.1" },
      }),
    );
    const echo = await echoOf(res);
    expect(echo.headers["x-forwarded-for"]).toBe("1.1.1.1, 9.9.9.9");
    expect(echo.headers["x-forwarded-proto"]).toBe("http");
    expect(echo.headers["x-forwarded-host"]).toBe("localhost");

    const peerOnly = await echoOf(
      await app.fetch(
        new Request("http://localhost/proxy/echo", { headers: { "x-mino-peer": "9.9.9.9" } }),
      ),
    );
    expect(peerOnly.headers["x-forwarded-for"]).toBe("9.9.9.9");
  });

  it("keeps existing x-forwarded-for when no peer is known", async () => {
    const app = proxyApp(upstream());
    const res = await app.fetch(
      new Request("http://localhost/proxy/echo", { headers: { "x-forwarded-for": "2.2.2.2" } }),
    );
    const echo = await echoOf(res);
    expect(echo.headers["x-forwarded-for"]).toBe("2.2.2.2");
  });

  it("opts.headers record overrides; Headers instance merges; function can strip auth", async () => {
    const rec = proxyApp(upstream(), { headers: { "x-tag": "rec" } });
    const echoRec = await echoOf(await rec.fetch(new Request("http://localhost/proxy/echo")));
    expect(echoRec.headers["x-tag"]).toBe("rec");

    const inst = proxyApp(upstream(), { headers: new Headers({ "x-tag": "inst" }) });
    const echoInst = await echoOf(await inst.fetch(new Request("http://localhost/proxy/echo")));
    expect(echoInst.headers["x-tag"]).toBe("inst");

    const strip = proxyApp(upstream(), {
      headers: (outgoing) => {
        outgoing.delete("authorization");
        outgoing.set("x-tag", "fn");
      },
    });
    const echoStrip = await echoOf(
      await strip.fetch(
        new Request("http://localhost/proxy/echo", { headers: { authorization: "Bearer s3cr3t" } }),
      ),
    );
    expect(echoStrip.headers["authorization"]).toBeUndefined();
    expect(echoStrip.headers["x-tag"]).toBe("fn");
  });

  it("string target joins an origin prefix; rewrite mutates the URL", async () => {
    const app = proxyApp(`${upstream()}/v1/`, {
      rewrite: (url) => {
        url.searchParams.set("token", "abc");
      },
    });
    const res = await app.fetch(new Request("http://localhost/proxy/echo?x=1"));
    const echo = await echoOf(res);
    expect(echo.path).toBe("/v1/proxy/echo");
    expect(echo.query).toContain("x=1");
    expect(echo.query).toContain("token=abc");
  });

  it("function target resolves the upstream URL dynamically", async () => {
    const app = proxyApp(
      (req) => `${upstream()}/dyn?orig=${encodeURIComponent(new URL(req.url).pathname)}`,
    );
    const res = await app.fetch(new Request("http://localhost/proxy/echo"));
    expect(res.status).toBe(201);
    const echo = (await res.json()) as EchoBody;
    expect(echo.path).toBe("/dyn");
    expect(echo.query).toContain("orig=%2Fproxy%2Fecho");
  });

  it("passes upstream error statuses through (no 502 mapping)", async () => {
    const app = proxyApp(`${upstream()}/teapot`);
    const res = await app.fetch(new Request("http://localhost/proxy/anything"));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("teapot");
  });

  it("preserves multiple set-cookie values separately", async () => {
    const app = proxyApp(`${upstream()}/cookies`);
    const res = await app.fetch(new Request("http://localhost/proxy/anything"));
    expect(res.status).toBe(201);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("a=1");
    expect(cookies[1]).toContain("b=2");
  });

  it("GET without body and empty POST work (no duplex issues)", async () => {
    const app = proxyApp(upstream());
    const get = await echoOf(await app.fetch(new Request("http://localhost/proxy/echo")));
    expect(get.method).toBe("GET");
    expect(get.body).toBe("");
    const post = await echoOf(
      await app.fetch(new Request("http://localhost/proxy/echo", { method: "POST" })),
    );
    expect(post.method).toBe("POST");
  });

  it("502 JSON {code:bad_gateway} on connection refused, generic message", async () => {
    const app = proxyApp("http://127.0.0.1:1");
    const res = await app.fetch(new Request("http://localhost/proxy/echo"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bad Gateway", status: 502, code: "bad_gateway" });
  });

  it("502 on upstream timeout; throwing target also 502s", async () => {
    const app = proxyApp(`${upstream()}/hang`, { timeoutMs: 50 });
    const res = await app.fetch(new Request("http://localhost/proxy/echo"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bad Gateway", status: 502, code: "bad_gateway" });

    const bad = proxyApp(() => {
      throw new Error("nope");
    });
    const res2 = await bad.fetch(new Request("http://localhost/proxy/echo"));
    expect(res2.status).toBe(502);
  });
});

// ─────────────────────────────────────────────────────────────────
// combine
// ─────────────────────────────────────────────────────────────────

describe("track-c combine", () => {
  function twoApps(): { api: Mino; web: Mino } {
    const api = new Mino();
    api.get("/api/hello", (c) => c.json({ from: "api" }));
    const web = new Mino();
    web.get("/api-test", (c) => c.text("web"));
    web.get("/", (c) => c.text("web-root"));
    return { api, web };
  }

  it("longest-prefix match wins", async () => {
    const { api, web } = twoApps();
    const gateway = combine([
      { prefix: "/", app: web },
      { prefix: "/api", app: api },
    ]);
    const res = await gateway(new Request("http://localhost/api/hello"));
    expect(await res.json()).toEqual({ from: "api" });
    const root = await gateway(new Request("http://localhost/"));
    expect(await root.text()).toBe("web-root");
  });

  it("prefix is strict (/api does not swallow /api-test)", async () => {
    const { api, web } = twoApps();
    const gateway = combine([
      { prefix: "/api", app: api },
      { prefix: "/", app: web },
    ]);
    const res = await gateway(new Request("http://localhost/api-test"));
    expect(await res.text()).toBe("web");
  });

  it("first match wins on ties; default prefix is /; slashes normalized", async () => {
    // combine strips nothing — sub-apps register their full paths.
    const a = new Mino();
    a.get("/dup/x", (c) => c.text("a"));
    a.get("/x", (c) => c.text("a"));
    a.get("/api/x", (c) => c.text("a"));
    const b = new Mino();
    b.get("/dup/x", (c) => c.text("b"));
    const gateway = combine([
      { prefix: "/dup", app: a },
      { prefix: "/dup", app: b },
    ]);
    expect(await (await gateway(new Request("http://localhost/dup/x"))).text()).toBe("a");

    const bare = combine([{ app: a }]);
    expect(await (await bare(new Request("http://localhost/x"))).text()).toBe("a");

    const odd = combine([{ prefix: "api/", app: a }]);
    expect(await (await odd(new Request("http://localhost/api/x"))).text()).toBe("a");
  });

  it("no match answers 404 JSON", async () => {
    const { api } = twoApps();
    const gateway = combine([{ prefix: "/api", app: api }]);
    const res = await gateway(new Request("http://localhost/other"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found", status: 404, code: "not_found" });
  });

  it("preserves sub-app middleware and the full path (strips nothing)", async () => {
    const sub = new Mino();
    sub.use(async (c, next) => {
      await next();
      const res = c.res;
      if (res) {
        const out = new Response(res.body, { status: res.status, headers: res.headers });
        out.headers.set("x-sub-mw", "ran");
        c.setResponse(out);
        return out;
      }
    });
    sub.get("/api/hello", (c) => c.json({ path: c.path }));
    const gateway = combine([{ prefix: "/api", app: sub }]);
    const res = await gateway(new Request("http://localhost/api/hello"));
    expect(res.headers.get("x-sub-mw")).toBe("ran");
    expect(await res.json()).toEqual({ path: "/api/hello" });
  });
});

// ─────────────────────────────────────────────────────────────────
// under-pressure
// ─────────────────────────────────────────────────────────────────

describe("track-c under-pressure", () => {
  it("healthy requests call next() and pass through", async () => {
    const app = new Mino();
    let ran = false;
    app.use(underPressure({ maxLagMs: 60_000 }));
    app.get("/", (c) => {
      ran = true;
      return c.text("ok");
    });
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(ran).toBe(true);
  });

  it("overload short-circuits with 503 + Retry-After, downstream never runs", async () => {
    const app = new Mino();
    let ran = false;
    app.use(underPressure({ maxLagMs: -1, retryAfterSec: 2 }));
    app.get("/", (c) => {
      ran = true;
      return c.text("ok");
    });
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({
      error: "Service Unavailable",
      status: 503,
      code: "server_overloaded",
    });
    expect(ran).toBe(false);
  });

  it("heap pressure trips the guard; healthy heap passes", async () => {
    const hot = createPressureMonitor({ maxLagMs: 60_000, maxHeapMB: 100, heapSample: () => 999 });
    expect(hot.isUnderPressure()).toBe(true);
    expect(hot.sample()).toMatchObject({ heapMB: 999 });
    hot.stop();

    const cool = createPressureMonitor({
      maxLagMs: 60_000,
      maxHeapMB: 100,
      heapSample: () => 10,
    });
    expect(cool.isUnderPressure()).toBe(false);
    cool.stop();

    const blind = createPressureMonitor({ maxLagMs: 60_000, heapSample: () => undefined });
    expect(blind.isUnderPressure()).toBe(false);
    expect(blind.sample().heapMB).toBeUndefined();
    blind.stop();
  });

  it("monitor samples lag over time and stops cleanly", async () => {
    const monitor = createPressureMonitor({ maxLagMs: 60_000, intervalMs: 5 });
    expect(monitor.isUnderPressure()).toBe(false);
    const first = monitor.sample();
    expect(typeof first.lagMs).toBe("number");
    await new Promise((r) => setTimeout(r, 60));
    const later = monitor.sample();
    expect(typeof later.lagMs).toBe("number");
    expect(later.lagMs).toBeGreaterThanOrEqual(0);
    monitor.stop();
    expect(monitor.isUnderPressure()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// websocket codec (no network)
// ─────────────────────────────────────────────────────────────────

describe("track-c websocket", () => {
  it("exposes the RFC 6455 GUID and the RFC accept vector", async () => {
    expect(WEBSOCKET_GUID).toBe("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    await expect(createAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")).resolves.toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
  });

  it("isWebSocketRequest validates the upgrade matrix", () => {
    const base = { upgrade: "websocket", "sec-websocket-key": "x", "sec-websocket-version": "13" };
    const req = (headers: Record<string, string>, method = "GET"): Request =>
      new Request("http://localhost/chat", { method, headers });
    expect(isWebSocketRequest(req(base))).toBe(true);
    expect(isWebSocketRequest(req({ ...base, upgrade: "WebSocket" }))).toBe(true);
    expect(isWebSocketRequest(req({ ...base, upgrade: "h2c, websocket" }))).toBe(true);
    expect(isWebSocketRequest(req(base, "POST"))).toBe(false);
    expect(isWebSocketRequest(req({ upgrade: "websocket", "sec-websocket-version": "13" }))).toBe(
      false,
    );
    expect(isWebSocketRequest(req({ ...base, "sec-websocket-key": "  " }))).toBe(false);
    expect(isWebSocketRequest(req({ ...base, "sec-websocket-version": "12" }))).toBe(false);
    expect(
      isWebSocketRequest(req({ "sec-websocket-key": "x", "sec-websocket-version": "13" })),
    ).toBe(false);
  });

  function roundTrip(opcode: number, data: Uint8Array | string, masked: boolean): WsFrame[] {
    const frames: WsFrame[] = [];
    const parser = createFrameParser((f) => frames.push(f));
    parser.push(encodeFrame({ opcode, data, masked }));
    return frames;
  }

  it("round-trips text, binary, empty, and string payloads", () => {
    const [text] = roundTrip(Opcode.Text, "hello", false);
    expect(text?.opcode).toBe(Opcode.Text);
    expect(new TextDecoder().decode(text?.data)).toBe("hello");

    const [bin] = roundTrip(Opcode.Binary, new Uint8Array([0, 1, 2, 255]), false);
    expect(bin?.opcode).toBe(Opcode.Binary);
    expect(bin?.data).toEqual(new Uint8Array([0, 1, 2, 255]));

    const [empty] = roundTrip(Opcode.Binary, new Uint8Array(0), false);
    expect(empty?.data.byteLength).toBe(0);
    expect(empty?.fin).toBe(true);
  });

  it("round-trips 16-bit (200B) and 64-bit (64KB) lengths, masked and unmasked", () => {
    const medium = new Uint8Array(200).fill(7);
    const [m] = roundTrip(Opcode.Binary, medium, false);
    expect(m?.data).toEqual(medium);

    const big = new Uint8Array(65536);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const [u] = roundTrip(Opcode.Binary, big, false);
    expect(u?.data).toEqual(big);
    const [masked] = roundTrip(Opcode.Text, "masked-payload", true);
    expect(new TextDecoder().decode(masked?.data)).toBe("masked-payload");
    const [maskedBig] = roundTrip(Opcode.Binary, big, true);
    expect(maskedBig?.data).toEqual(big);
  });

  it("reassembles split headers, masks, and payloads across pushes", () => {
    const frames: WsFrame[] = [];
    const parser = createFrameParser((f) => frames.push(f));
    // 200-byte frame split inside the 16-bit extended length + payload.
    const medium = encodeFrame({ opcode: Opcode.Binary, data: new Uint8Array(200).fill(3) });
    parser.push(medium.slice(0, 3));
    parser.push(medium.slice(3, 100));
    expect(frames).toHaveLength(0);
    parser.push(medium.slice(100));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data.byteLength).toBe(200);
    // masked frame split inside the 4-byte mask key.
    const masked = encodeFrame({ opcode: Opcode.Text, data: "split-mask", masked: true });
    const out: WsFrame[] = [];
    const mp = createFrameParser((f) => out.push(f));
    mp.push(masked.slice(0, 4));
    mp.push(masked.slice(4));
    expect(new TextDecoder().decode(out[0]?.data)).toBe("split-mask");
  });

  it("reassembles fragments, even pushed one byte at a time", () => {
    const frames: WsFrame[] = [];
    const parser = createFrameParser((f) => frames.push(f));
    const first = encodeFrame({ opcode: Opcode.Text, data: "hel", fin: false });
    const second = encodeFrame({ opcode: Opcode.Continuation, data: "lo", fin: true });
    const wire = new Uint8Array(first.byteLength + second.byteLength);
    wire.set(first, 0);
    wire.set(second, first.byteLength);
    for (let i = 0; i < wire.length; i++) parser.push(wire.slice(i, i + 1));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.opcode).toBe(Opcode.Text);
    expect(new TextDecoder().decode(frames[0]?.data)).toBe("hello");
  });

  it("surfaces ping/pong/close frames to the callback", () => {
    const frames: WsFrame[] = [];
    const parser = createFrameParser((f) => frames.push(f));
    parser.push(encodeFrame({ opcode: Opcode.Ping, data: "pingdata" }));
    parser.push(encodeFrame({ opcode: Opcode.Pong, data: "pongdata" }));
    parser.push(encodeFrame({ opcode: Opcode.Close, data: new Uint8Array([3, 232]) }));
    expect(frames.map((f) => f.opcode)).toEqual([Opcode.Ping, Opcode.Pong, Opcode.Close]);
    expect(new TextDecoder().decode(frames[0]?.data)).toBe("pingdata");
    parser.push(new Uint8Array(0)); // empty push is a no-op
    expect(frames).toHaveLength(3);
  });

  it("rejects protocol violations with plain Errors", () => {
    const parser = (frames: WsFrame[]): ReturnType<typeof createFrameParser> =>
      createFrameParser((f) => frames.push(f));
    // control frame > 125 bytes (126 marker)
    expect(() => parser([]).push(new Uint8Array([0x89, 126, 0, 126]))).toThrowError(Error);
    // absurd 64-bit length (unsafe integer, header only — no big alloc)
    expect(() =>
      parser([]).push(new Uint8Array([0x82, 127, 255, 255, 255, 255, 255, 255, 255, 255])),
    ).toThrowError(Error);
    // fragmented ping (FIN clear)
    expect(() => parser([]).push(new Uint8Array([0x09, 0]))).toThrowError(Error);
    // stray continuation with no message in flight
    expect(() =>
      parser([]).push(encodeFrame({ opcode: Opcode.Continuation, data: "x", fin: true })),
    ).toThrowError(Error);
    // new fragmented message while one is in flight
    const p = parser([]);
    p.push(encodeFrame({ opcode: Opcode.Text, data: "a", fin: false }));
    expect(() => p.push(encodeFrame({ opcode: Opcode.Binary, data: "b", fin: false }))).toThrow(
      Error,
    );
    // complete frame while a fragmented message is in flight
    const q = parser([]);
    q.push(encodeFrame({ opcode: Opcode.Text, data: "a", fin: false }));
    expect(() => q.push(encodeFrame({ opcode: Opcode.Text, data: "b", fin: true }))).toThrow(Error);
  });

  it("builds the 101 upgrade carrier, with optional subprotocol", async () => {
    const accept = await createAcceptKey("dGhlIHNhbXBsZSBub25jZQ==");
    const res = websocketUpgradeResponse(accept);
    expect(res.status).toBe(101);
    expect(res.headers.get("upgrade")).toBe("websocket");
    expect(res.headers.get("connection")).toBe("Upgrade");
    expect(res.headers.get("sec-websocket-accept")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(res.headers.get("sec-websocket-protocol")).toBeNull();
    const withProto = websocketUpgradeResponse(accept, { protocol: "chat" });
    expect(withProto.headers.get("sec-websocket-protocol")).toBe("chat");
  });
});
