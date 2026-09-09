import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { responseTime } from "../src/response-time.js";
import { poweredBy } from "../src/powered-by.js";
import { ipRestrict } from "../src/ip-restriction.js";
import { formbody } from "../src/formbody.js";
import { cache } from "../src/cache.js";
import { validator } from "../src/validator.js";

/** Invoke middleware directly with a shaped stub (covers no-response paths). */
type StubMw = (c: unknown, next: () => Promise<void>) => Promise<unknown>;

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

function peer(ip: string): Record<string, string> {
  return { "x-mino-peer": ip };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── response-time ───────────────────────────────────────────────────────────
describe("track B: response-time", () => {
  it("sets x-response-time with an ms-suffixed value", async () => {
    const app = new Mino();
    app.use(responseTime());
    app.get("/t", (c) => c.text("hi"));
    const res = await app.fetch(req("/t"));
    expect(await res.text()).toBe("hi");
    expect(res.headers.get("x-response-time")).toMatch(/^\d+\.\d{3}ms$/);
  });

  it("honors a custom header name", async () => {
    const app = new Mino();
    app.use(responseTime({ header: "x-elapsed" }));
    app.get("/t", (c) => c.text("hi"));
    const res = await app.fetch(req("/t"));
    expect(res.headers.get("x-elapsed")).toMatch(/ms$/);
    expect(res.headers.get("x-response-time")).toBe(null);
  });

  it("adds the header on 4xx/5xx downstream responses without altering them", async () => {
    const app = new Mino();
    app.use(responseTime());
    app.get("/nf", (c) => c.json({ error: "Nope", status: 404 }, 404));
    app.get("/boom", (c) => c.json({ error: "Broke", status: 500 }, 500));
    const nf = await app.fetch(req("/nf"));
    expect(nf.status).toBe(404);
    expect(nf.headers.get("x-response-time")).toMatch(/ms$/);
    expect(await nf.json()).toEqual({ error: "Nope", status: 404 });
    const boom = await app.fetch(req("/boom"));
    expect(boom.status).toBe(500);
    expect(boom.headers.get("x-response-time")).toMatch(/ms$/);
  });

  it("no-ops safely when c.res is missing", async () => {
    const mw = responseTime() as unknown as StubMw;
    await expect(mw({ res: undefined }, async () => {})).resolves.toBeUndefined();
  });
});

// ─── powered-by ──────────────────────────────────────────────────────────────
describe("track B: powered-by", () => {
  it("sets x-powered-by: Mino by default", async () => {
    const app = new Mino();
    app.use(poweredBy());
    app.get("/t", (c) => c.text("hi"));
    const res = await app.fetch(req("/t"));
    expect(res.headers.get("x-powered-by")).toBe("Mino");
    expect(await res.text()).toBe("hi");
  });

  it("sets a custom name", async () => {
    const app = new Mino();
    app.use(poweredBy("Acme"));
    app.get("/t", (c) => c.text("hi"));
    expect((await app.fetch(req("/t"))).headers.get("x-powered-by")).toBe("Acme");
  });

  it("explicit handler header wins (helmet-style)", async () => {
    const app = new Mino();
    app.use(poweredBy());
    app.get("/t", () => new Response("hi", { headers: { "x-powered-by": "Custom" } }));
    const res = await app.fetch(req("/t"));
    expect(res.headers.get("x-powered-by")).toBe("Custom");
    expect(await res.text()).toBe("hi");
  });

  it("poweredBy(false) removes a downstream header", async () => {
    const app = new Mino();
    app.use(poweredBy(false));
    app.get("/t", () => new Response("hi", { headers: { "x-powered-by": "Leaky" } }));
    const res = await app.fetch(req("/t"));
    expect(res.headers.get("x-powered-by")).toBe(null);
    expect(await res.text()).toBe("hi");
  });

  it("poweredBy(false) without a downstream header is a clean pass-through", async () => {
    const app = new Mino();
    app.use(poweredBy(false));
    app.get("/t", (c) => c.text("hi"));
    const res = await app.fetch(req("/t"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-powered-by")).toBe(null);
  });

  it("no-ops safely when c.res is missing", async () => {
    const mw = poweredBy() as unknown as StubMw;
    await expect(mw({ res: undefined }, async () => {})).resolves.toBeUndefined();
  });
});

// ─── ip-restriction ──────────────────────────────────────────────────────────
describe("track B: ip-restriction", () => {
  it("allow: matching peer passes, others get 403 JSON", async () => {
    const app = new Mino();
    app.use(ipRestrict({ allow: ["9.9.9.9"] }));
    app.get("/t", (c) => c.text("ok"));
    const ok = await app.fetch(req("/t", { headers: peer("9.9.9.9") }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");
    const blocked = await app.fetch(req("/t", { headers: peer("1.1.1.1") }));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "Forbidden", status: 403, code: "forbidden" });
  });

  it("deny: listed peer blocked, others pass", async () => {
    const app = new Mino();
    app.use(ipRestrict({ deny: ["1.2.3.4"] }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: peer("1.2.3.4") }))).status).toBe(403);
    const ok = await app.fetch(req("/t", { headers: peer("9.9.9.9") }));
    expect(ok.status).toBe(200);
  });

  it("deny wins over allow overlap", async () => {
    const app = new Mino();
    app.use(ipRestrict({ allow: ["10.0.0.0/8"], deny: ["10.0.0.99"] }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: peer("10.0.0.99") }))).status).toBe(403);
    expect((await app.fetch(req("/t", { headers: peer("10.0.0.1") }))).status).toBe(200);
  });

  it("IPv4 CIDR allow matches the range only", async () => {
    const app = new Mino();
    app.use(ipRestrict({ allow: ["10.0.0.0/8"] }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: peer("10.1.2.3") }))).status).toBe(200);
    expect((await app.fetch(req("/t", { headers: peer("11.0.0.1") }))).status).toBe(403);
  });

  it("malformed entries throw at construction (fail fast)", () => {
    for (const bad of [
      "not-an-ip",
      "",
      "1.2.3.4.5",
      "1.2.3.256",
      "1.2.3.999",
      "1.2.3.",
      "1.2.3.1234",
      "a.b.c.d",
      "1.2.3.4/33",
      "1.2.3.4/xx",
      "1.2.3.4/-1",
      "1.2.3.4/",
      "::1/129",
      "nope/24",
      "/24",
      "1::2::3",
      "gggg::1",
      "::ffff:1.2.3.999",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8::",
    ]) {
      expect(() => ipRestrict({ allow: [bad] }), bad).toThrowError(Error);
      expect(() => ipRestrict({ deny: [bad] }), bad).toThrowError(Error);
    }
  });

  it("IPv6 exact: ::1 allowed, IPv4 peer not", async () => {
    const app = new Mino();
    app.use(ipRestrict({ allow: ["::1"] }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: peer("::1") }))).status).toBe(200);
    expect((await app.fetch(req("/t", { headers: peer("::") }))).status).toBe(403);
    expect((await app.fetch(req("/t", { headers: peer("127.0.0.1") }))).status).toBe(403);
  });

  it("IPv6 full-form exact matches; IPv4 peer never matches IPv6 entries", async () => {
    const app = new Mino();
    app.use(ipRestrict({ allow: ["1:2:3:4:5:6:7:8"] }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: peer("1:2:3:4:5:6:7:8") }))).status).toBe(200);
    expect((await app.fetch(req("/t", { headers: peer("1.2.3.4") }))).status).toBe(403);
  });

  it("IPv6 CIDR prefix matches the range only", async () => {
    const app = new Mino();
    app.use(ipRestrict({ allow: ["2001:db8::/32"] }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: peer("2001:db8::1") }))).status).toBe(200);
    expect((await app.fetch(req("/t", { headers: peer("2001:db9::1") }))).status).toBe(403);
  });

  it("::ffff:a.b.c.d tails match IPv4 entries", async () => {
    const app = new Mino();
    app.use(ipRestrict({ deny: ["1.2.3.4"] }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: peer("::ffff:1.2.3.4") }))).status).toBe(403);
    const ok = await app.fetch(req("/t", { headers: peer("::ffff:9.9.9.9") }));
    expect(ok.status).toBe(200);
  });

  it("X-Forwarded-For is ignored by default (spoof-safe)", async () => {
    const app = new Mino();
    app.use(ipRestrict({ deny: ["5.6.7.8"] }));
    app.get("/t", (c) => c.text("ok"));
    // Spoofed XFF alone must not trigger the deny bucket.
    const spoofed = await app.fetch(req("/t", { headers: { "x-forwarded-for": "5.6.7.8" } }));
    expect(spoofed.status).toBe(200);
    // ...but the real peer signal still blocks.
    expect((await app.fetch(req("/t", { headers: peer("5.6.7.8") }))).status).toBe(403);

    const allowOnly = new Mino();
    allowOnly.use(ipRestrict({ allow: ["9.9.9.9"] }));
    allowOnly.get("/t", (c) => c.text("ok"));
    // Spoofed XFF alone must not satisfy the allow list (peer falls back to "global").
    expect(
      (await allowOnly.fetch(req("/t", { headers: { "x-forwarded-for": "9.9.9.9" } }))).status,
    ).toBe(403);
    expect((await allowOnly.fetch(req("/t", { headers: peer("9.9.9.9") }))).status).toBe(200);
  });

  it("trustProxy:true honors X-Forwarded-For", async () => {
    const app = new Mino();
    app.use(ipRestrict({ deny: ["5.6.7.8"], trustProxy: true }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: { "x-forwarded-for": "5.6.7.8" } }))).status).toBe(
      403,
    );
    expect((await app.fetch(req("/t", { headers: { "x-forwarded-for": "1.1.1.1" } }))).status).toBe(
      200,
    );
  });

  it("/0 prefixes match their whole family", async () => {
    const app = new Mino();
    app.use(ipRestrict({ allow: ["0.0.0.0/0", "::/0"] }));
    app.get("/t", (c) => c.text("ok"));
    expect((await app.fetch(req("/t", { headers: peer("192.168.1.50") }))).status).toBe(200);
    expect((await app.fetch(req("/t", { headers: peer("::1") }))).status).toBe(200);
  });

  it("custom 403 message is surfaced with the forbidden code", async () => {
    const app = new Mino();
    app.use(ipRestrict({ deny: ["1.2.3.4"], message: "Nope" }));
    app.get("/t", (c) => c.text("ok"));
    const res = await app.fetch(req("/t", { headers: peer("1.2.3.4") }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Nope", status: 403, code: "forbidden" });
  });
});

// ─── formbody ────────────────────────────────────────────────────────────────
describe("track B: formbody", () => {
  const FORM = { "content-type": "application/x-www-form-urlencoded" };

  it("parses pairs with +-as-space decoding", async () => {
    const app = new Mino();
    app.post("/s", formbody(), (c) => c.json(c.valid("form")));
    const res = await app.fetch(
      req("/s", { method: "POST", headers: FORM, body: "a=1&b=hello+world" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: "1", b: "hello world" });
  });

  it("LAST value wins; percent-decoding, key-only, empty, malformed-escape, skipped empties", async () => {
    const app = new Mino();
    app.post("/s", formbody(), (c) => c.json(c.valid("form")));
    const res = await app.fetch(
      req("/s", {
        method: "POST",
        headers: FORM,
        body: "k=first&&k=second&x=%26%3D&flag&bad=%ZZ&empty=",
      }),
    );
    expect(await res.json()).toEqual({ k: "second", x: "&=", flag: "", bad: "%ZZ", empty: "" });
  });

  it("empty body yields an empty object", async () => {
    const app = new Mino();
    app.post("/s", formbody(), (c) => c.json(c.valid("form")));
    const res = await app.fetch(req("/s", { method: "POST", headers: FORM, body: "" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("pair count past c.limits.fieldCount is 413", async () => {
    const app = new Mino({ limits: { fieldCount: 2 } });
    app.post("/s", formbody(), (c) => c.text("unreached"));
    const res = await app.fetch(req("/s", { method: "POST", headers: FORM, body: "a=1&b=2&c=3" }));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ status: 413, code: "payload_too_large" });
  });

  it("body past opts.limit is 413", async () => {
    const app = new Mino();
    app.post("/s", formbody({ limit: 8 }), (c) => c.text("unreached"));
    const res = await app.fetch(req("/s", { method: "POST", headers: FORM, body: "a=1234567890" }));
    expect(res.status).toBe(413);
  });

  it("non-urlencoded content passes straight through", async () => {
    const app = new Mino();
    app.post("/j", formbody(), (c) =>
      c.text(`reached:${c.valid("form") === undefined ? "novalid" : "has"}`),
    );
    const res = await app.fetch(
      req("/j", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("reached:novalid");
    // Missing content-type entirely also passes straight through.
    const bare = await app.fetch(req("/j", { method: "POST" }));
    expect(bare.status).toBe(200);
    expect(await bare.text()).toBe("reached:novalid");
  });

  it("validator('form') reuses the cached parse", async () => {
    const echo = { safeParse: (v: unknown) => ({ success: true as const, data: v }) };
    const needName = {
      safeParse: (v: unknown) => {
        const o = v as Record<string, unknown>;
        return typeof o["name"] === "string" && o["name"] !== ""
          ? { success: true as const, data: o }
          : { success: false as const, error: { issues: [{ message: "name required" }] } };
      },
    };
    const app = new Mino();
    app.post("/echo", formbody(), validator("form", echo as never), (c) => c.json(c.valid("form")));
    app.post("/need", formbody(), validator("form", needName as never), (c) =>
      c.json(c.valid("form")),
    );
    const ok = await app.fetch(
      req("/echo", { method: "POST", headers: FORM, body: "name=a&age=3" }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ name: "a", age: "3" });
    const bad = await app.fetch(req("/need", { method: "POST", headers: FORM, body: "age=3" }));
    expect(bad.status).toBe(422);
  });
});

// ─── cache ───────────────────────────────────────────────────────────────────
describe("track B: cache", () => {
  it("MISS then HIT with identical body (handler runs once)", async () => {
    let n = 0;
    const app = new Mino();
    app.use(cache());
    app.get("/r", (c) => c.text(`v${++n}`));
    const first = await app.fetch(req("/r"));
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(await first.text()).toBe("v1");
    const second = await app.fetch(req("/r"));
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.text()).toBe("v1");
    expect(n).toBe(1);
  });

  it("entries expire after ttlMs (short ttl + sleep)", async () => {
    let n = 0;
    const app = new Mino();
    app.use(cache({ ttlMs: 25 }));
    app.get("/t", (c) => c.text(`v${++n}`));
    expect((await app.fetch(req("/t"))).headers.get("x-cache")).toBe("MISS");
    expect((await app.fetch(req("/t"))).headers.get("x-cache")).toBe("HIT");
    await sleep(60);
    expect((await app.fetch(req("/t"))).headers.get("x-cache")).toBe("MISS");
    expect((await app.fetch(req("/t"))).headers.get("x-cache")).toBe("HIT");
    expect(n).toBe(2);
  });

  it("cache-control: no-cache bypasses without poisoning the entry", async () => {
    let n = 0;
    const app = new Mino();
    app.use(cache());
    app.get("/n", (c) => c.text(`v${++n}`));
    const prime = await app.fetch(req("/n"));
    expect(await prime.text()).toBe("v1");
    const bypass = await app.fetch(req("/n", { headers: { "cache-control": "no-cache" } }));
    expect(bypass.headers.get("x-cache")).toBe(null);
    expect(await bypass.text()).toBe("v2");
    const after = await app.fetch(req("/n"));
    expect(after.headers.get("x-cache")).toBe("HIT");
    expect(await after.text()).toBe("v1");
  });

  it("authorization bypasses by default and never populates", async () => {
    let n = 0;
    const app = new Mino();
    app.use(cache());
    app.get("/a", (c) => c.text(`v${++n}`));
    expect((await app.fetch(req("/a"))).headers.get("x-cache")).toBe("MISS");
    const auth = { authorization: "Bearer s3cret" };
    expect((await app.fetch(req("/a", { headers: auth }))).headers.get("x-cache")).toBe(null);
    expect((await app.fetch(req("/a", { headers: auth }))).headers.get("x-cache")).toBe(null);
    expect(n).toBe(3);
    const plain = await app.fetch(req("/a"));
    expect(plain.headers.get("x-cache")).toBe("HIT");
    expect(await plain.text()).toBe("v1");
  });

  it("private:true caches authorized requests", async () => {
    let n = 0;
    const app = new Mino();
    app.use(cache({ private: true }));
    app.get("/p", (c) => c.text(`v${++n}`));
    const auth = { authorization: "Bearer s3cret" };
    expect((await app.fetch(req("/p", { headers: auth }))).headers.get("x-cache")).toBe("MISS");
    const second = await app.fetch(req("/p", { headers: auth }));
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.text()).toBe("v1");
    expect(n).toBe(1);
  });

  it("non-200 responses pass through unmarked and are never cached", async () => {
    const app = new Mino();
    app.use(cache());
    app.get("/nf", (c) => c.json({ error: "Nope", status: 404 }, 404));
    const first = await app.fetch(req("/nf"));
    expect(first.status).toBe(404);
    expect(first.headers.get("x-cache")).toBe(null);
    const second = await app.fetch(req("/nf"));
    expect(second.status).toBe(404);
    expect(second.headers.get("x-cache")).toBe(null);
  });

  it("bodyless 200s pass through unmarked", async () => {
    const app = new Mino();
    app.use(cache());
    app.get("/e", () => new Response(null, { status: 200 }));
    const first = await app.fetch(req("/e"));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe(null);
    expect((await app.fetch(req("/e"))).headers.get("x-cache")).toBe(null);
  });

  it("POST passes through (default methods: GET only)", async () => {
    const app = new Mino();
    app.use(cache());
    app.post("/p", (c) => c.text("posted"));
    const first = await app.fetch(req("/p", { method: "POST" }));
    expect(first.headers.get("x-cache")).toBe(null);
    expect((await app.fetch(req("/p", { method: "POST" }))).headers.get("x-cache")).toBe(null);
  });

  it("custom methods list can cache POST", async () => {
    let n = 0;
    const app = new Mino();
    app.use(cache({ methods: ["GET", "POST"] }));
    app.post("/m", (c) => c.text(`v${++n}`));
    expect((await app.fetch(req("/m", { method: "POST" }))).headers.get("x-cache")).toBe("MISS");
    const second = await app.fetch(req("/m", { method: "POST" }));
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.text()).toBe("v1");
  });

  it("evicts oldest-first past maxEntries", async () => {
    let n = 0;
    const app = new Mino();
    app.use(cache({ maxEntries: 2 }));
    app.get("/e", (c) => c.text(`v${++n}`));
    expect((await app.fetch(req("/e?1"))).headers.get("x-cache")).toBe("MISS"); // v1
    expect((await app.fetch(req("/e?2"))).headers.get("x-cache")).toBe("MISS"); // v2
    const hit = await app.fetch(req("/e?1"));
    expect(hit.headers.get("x-cache")).toBe("HIT");
    expect(await hit.text()).toBe("v1");
    expect((await app.fetch(req("/e?3"))).headers.get("x-cache")).toBe("MISS"); // v3, evicts ?1
    const evicted = await app.fetch(req("/e?1"));
    expect(evicted.headers.get("x-cache")).toBe("MISS"); // v4, evicts ?2
    expect(await evicted.text()).toBe("v4");
    expect((await app.fetch(req("/e?2"))).headers.get("x-cache")).toBe("MISS"); // evicted
    const kept = await app.fetch(req("/e?1"));
    expect(kept.headers.get("x-cache")).toBe("HIT");
    expect(await kept.text()).toBe("v4");
  });

  it("expired entries are swept on insert so live entries survive", async () => {
    let n = 0;
    const app = new Mino();
    app.use(cache({ maxEntries: 1, ttlMs: 25 }));
    app.get("/s", (c) => c.text(`v${++n}`));
    expect((await app.fetch(req("/s?1"))).headers.get("x-cache")).toBe("MISS");
    await sleep(60);
    // ?1 is stale: swept during this insert instead of forcing out anything live.
    expect((await app.fetch(req("/s?2"))).headers.get("x-cache")).toBe("MISS");
    expect((await app.fetch(req("/s?2"))).headers.get("x-cache")).toBe("HIT");
    expect(n).toBe(2);
  });

  it("oversize single entries are served but not stored", async () => {
    const big = "x".repeat(6 * 1024 * 1024);
    const app = new Mino();
    app.use(cache());
    app.get("/big", (c) => c.text(big));
    const first = await app.fetch(req("/big"));
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect((await first.text()).length).toBe(big.length);
    expect((await app.fetch(req("/big"))).headers.get("x-cache")).toBe("MISS");
  });

  it("no-ops when no downstream response exists", async () => {
    const mw = cache() as unknown as StubMw;
    const fake = {
      method: "GET",
      req: req("/z"),
      header: () => undefined,
      res: undefined,
      setResponse: () => {},
    };
    await expect(mw(fake, async () => {})).resolves.toBeUndefined();
  });

  it("passes through when buffering the body fails", async () => {
    const mw = cache() as unknown as StubMw;
    let stored: Response | undefined;
    const bad = new Response(
      new ReadableStream<string>({
        start(c) {
          c.error(new Error("boom"));
        },
      }),
      { status: 200 },
    );
    const fake = {
      method: "GET",
      req: req("/z"),
      header: () => undefined,
      res: bad,
      setResponse: (r: Response) => {
        stored = r;
      },
    };
    await expect(mw(fake, async () => {})).resolves.toBeUndefined();
    expect(stored).toBeUndefined();
  });
});
