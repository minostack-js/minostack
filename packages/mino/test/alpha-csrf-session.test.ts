import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { csrf, csrfWithStore, generateCsrfToken, safeEqual } from "../src/csrf.js";
import { session, MemoryStore, generateSessionId, regenerateSessionId } from "../src/session.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const v = h.get("set-cookie");
  return v ? [v] : [];
}

function cookiePair(res: Response, name: string): string | undefined {
  return setCookies(res)
    .map((s) => (s.split(";")[0] ?? "").trim())
    .find((s) => s.startsWith(`${name}=`));
}

function tokenFrom(res: Response, name: string): string | undefined {
  const pair = cookiePair(res, name);
  if (!pair) return undefined;
  return decodeURIComponent(pair.slice(name.length + 1));
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

// ─────────────────────────────────────────────────────────────────
// csrf: double-submit
// ─────────────────────────────────────────────────────────────────

function csrfApp(): { app: Mino; downstream: { n: number } } {
  const downstream = { n: 0 };
  const app = new Mino();
  app.use(csrf());
  app.get("/", (c) => c.text("ok"));
  app.post("/submit", (c) => {
    downstream.n++;
    return c.json({ ok: true });
  });
  return { app, downstream };
}

async function csrfPair(app: Mino): Promise<{ cookie: string; token: string }> {
  const res = await app.fetch(req("/"));
  const token = tokenFrom(res, "csrf-token");
  if (!token) throw new Error("expected csrf-token cookie");
  return { cookie: `csrf-token=${encodeURIComponent(token)}`, token };
}

describe("alpha: csrf double-submit", () => {
  it("safe GET issues a token cookie and reaches downstream", async () => {
    const { app } = csrfApp();
    const res = await app.fetch(req("/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const token = tokenFrom(res, "csrf-token");
    expect(token).toBeDefined();
    expect(token?.length).toBe(32);
  });

  it("safe GET with an existing cookie does not re-issue", async () => {
    const { app } = csrfApp();
    const { cookie } = await csrfPair(app);
    const res = await app.fetch(req("/", { headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(cookiePair(res, "csrf-token")).toBeUndefined();
  });

  it("unsafe POST without a token is 403 and skips downstream", async () => {
    const { app, downstream } = csrfApp();
    const res = await app.fetch(req("/submit", { method: "POST" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: 403, code: "csrf_failed" });
    expect(downstream.n).toBe(0);
  });

  it("unsafe POST with matching cookie+header passes", async () => {
    const { app, downstream } = csrfApp();
    const { cookie, token } = await csrfPair(app);
    const res = await app.fetch(
      req("/submit", { method: "POST", headers: { cookie, "x-csrf-token": token } }),
    );
    expect(res.status).toBe(200);
    expect(downstream.n).toBe(1);
  });

  it("unsafe POST with mismatched header is 403", async () => {
    const { app, downstream } = csrfApp();
    const { cookie } = await csrfPair(app);
    const res = await app.fetch(
      req("/submit", { method: "POST", headers: { cookie, "x-csrf-token": "wrong-token" } }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "csrf_failed" });
    expect(downstream.n).toBe(0);
  });

  it("unsafe POST with header but no cookie is 403", async () => {
    const { app } = csrfApp();
    const res = await app.fetch(
      req("/submit", { method: "POST", headers: { "x-csrf-token": "whatever" } }),
    );
    expect(res.status).toBe(403);
  });

  it("cross-origin Origin is rejected even with a valid token", async () => {
    const { app, downstream } = csrfApp();
    const { cookie, token } = await csrfPair(app);
    const res = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: { cookie, "x-csrf-token": token, origin: "https://evil.test" },
      }),
    );
    expect(res.status).toBe(403);
    expect(downstream.n).toBe(0);
  });

  it("same-origin Origin passes with a valid token", async () => {
    const { app, downstream } = csrfApp();
    const { cookie, token } = await csrfPair(app);
    const res = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: { cookie, "x-csrf-token": token, origin: "http://localhost" },
      }),
    );
    expect(res.status).toBe(200);
    expect(downstream.n).toBe(1);
  });

  it("cross-origin Referer is rejected", async () => {
    const { app } = csrfApp();
    const { cookie, token } = await csrfPair(app);
    const res = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: { cookie, "x-csrf-token": token, referer: "https://evil.test/page" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("malformed Origin is rejected", async () => {
    const { app } = csrfApp();
    const { cookie, token } = await csrfPair(app);
    const res = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: { cookie, "x-csrf-token": token, origin: "not-a-url" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("custom ignoreMethods lets listed unsafe methods through", async () => {
    const app = new Mino();
    app.use(csrf({ ignoreMethods: ["GET", "POST"] }));
    app.post("/submit", (c) => c.json({ ok: true }));
    const res = await app.fetch(req("/submit", { method: "POST" }));
    expect(res.status).toBe(200);
  });

  it("safeEqual compares in constant-time fashion; token gen honors length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("a", "ab")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(generateCsrfToken().length).toBe(32);
    expect(generateCsrfToken(16).length).toBe(16);
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });
});

// ─────────────────────────────────────────────────────────────────
// csrfWithStore: synchronizer mode
// ─────────────────────────────────────────────────────────────────

describe("alpha: csrf synchronizer store mode", () => {
  it("issues a server-backed token; the valid pair passes", async () => {
    const store = new MemoryStore();
    const app = new Mino();
    app.use(csrfWithStore({ store }));
    let downstream = 0;
    app.get("/", (c) => c.text("ok"));
    app.post("/submit", (c) => {
      downstream++;
      return c.json({ ok: true });
    });
    const get = await app.fetch(req("/"));
    const token = tokenFrom(get, "csrf-token");
    expect(token).toBeDefined();
    const cookie = `csrf-token=${encodeURIComponent(token ?? "")}`;
    const post = await app.fetch(
      req("/submit", { method: "POST", headers: { cookie, "x-csrf-token": token ?? "" } }),
    );
    expect(post.status).toBe(200);
    expect(downstream).toBe(1);
  });

  it("forged self-consistent pair without a store record is 403", async () => {
    const store = new MemoryStore();
    const app = new Mino();
    app.use(csrfWithStore({ store }));
    let downstream = 0;
    app.post("/submit", (c) => {
      downstream++;
      return c.json({ ok: true });
    });
    const forged = generateCsrfToken();
    const cookie = `csrf-token=${forged}`;
    const res = await app.fetch(
      req("/submit", { method: "POST", headers: { cookie, "x-csrf-token": forged } }),
    );
    expect(res.status).toBe(403);
    expect(downstream).toBe(0);
  });

  it("mismatched pair is 403", async () => {
    const store = new MemoryStore();
    const app = new Mino();
    app.use(csrfWithStore({ store }));
    app.get("/", (c) => c.text("ok"));
    app.post("/submit", (c) => c.json({ ok: true }));
    const get = await app.fetch(req("/"));
    const token = tokenFrom(get, "csrf-token") ?? "";
    const res = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: { cookie: `csrf-token=${token}`, "x-csrf-token": "other" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────
// session
// ─────────────────────────────────────────────────────────────────

const SECRET = "test-secret-for-mino-sessions-0123456789";

function sessionApp(store?: MemoryStore): Mino {
  const app = new Mino();
  app.use(session({ secret: SECRET, store }));
  app.post("/login", (c) => {
    (c.get("session") as Record<string, unknown>)["user"] = "ada";
    return c.json({ ok: true });
  });
  app.get("/me", (c) => {
    const s = c.get("session") as Record<string, unknown>;
    const user = s["user"];
    if (typeof user !== "string") {
      return c.json({ error: "Unauthorized", status: 401, code: "unauthorized" }, 401);
    }
    return c.json({ user });
  });
  app.post("/big", (c) => {
    (c.get("session") as Record<string, unknown>)["blob"] = "x".repeat(5000);
    return c.json({ ok: true });
  });
  app.post("/regen", (c) => {
    const before = c.get("sessionId") as string;
    (c.get("session") as Record<string, unknown>)["user"] = "ada";
    const after = regenerateSessionId(c);
    return c.json({ before, after });
  });
  app.post("/logout", (c) => {
    c.set("session", null);
    return c.json({ ok: true });
  });
  return app;
}

describe("alpha: session stateless", () => {
  it("round-trips data across requests via the cookie", async () => {
    const app = sessionApp();
    const login = await app.fetch(req("/login", { method: "POST" }));
    expect(login.status).toBe(200);
    const pair = cookiePair(login, "mino-session");
    expect(pair).toBeDefined();
    const me = await app.fetch(req("/me", { headers: { cookie: pair ?? "" } }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: "ada" });
  });

  it("tampered cookies are discarded (attacker data never lands)", async () => {
    const app = sessionApp();
    const login = await app.fetch(req("/login", { method: "POST" }));
    const pair = cookiePair(login, "mino-session") ?? "";
    const value = decodeURIComponent(pair.slice("mino-session=".length));
    // Flip the FIRST char: every leading base64 char carries 6 data bits, so
    // this always changes decoded bytes. (Flipping the LAST char is invisible
    // ~1/16 of the time — a 32-byte HMAC ends in 2 padding bits — making this
    // test flaky if pointed at the tail.)
    const tampered = (value.startsWith("A") ? "B" : "A") + value.slice(1);
    const me = await app.fetch(req("/me", { headers: { cookie: `mino-session=${tampered}` } }));
    expect(me.status).toBe(401);
  });

  it("malformed cookies start a fresh session", async () => {
    const app = sessionApp();
    const me = await app.fetch(req("/me", { headers: { cookie: "mino-session=garbage" } }));
    expect(me.status).toBe(401);
  });

  it("read-only requests do not set cookies", async () => {
    const app = sessionApp();
    const me = await app.fetch(req("/me"));
    expect(me.status).toBe(401);
    expect(cookiePair(me, "mino-session")).toBeUndefined();
  });

  it("oversize stateless sessions are rejected with 400", async () => {
    const app = sessionApp();
    const res = await app.fetch(req("/big", { method: "POST" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 400, code: "session_too_large" });
  });
});

describe("alpha: session with store", () => {
  it("keeps data server-side and persists across requests", async () => {
    const store = new MemoryStore();
    const app = sessionApp(store);
    const login = await app.fetch(req("/login", { method: "POST" }));
    expect(login.status).toBe(200);
    const pair = cookiePair(login, "mino-session") ?? "";
    const raw = decodeURIComponent(pair.slice("mino-session=".length));
    const payloadB64 = raw.split(".")[0] ?? "";
    const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
    expect(JSON.parse(json)).toMatchObject({ data: {} });
    const me = await app.fetch(req("/me", { headers: { cookie: pair } }));
    expect(await me.json()).toMatchObject({ user: "ada" });
  });

  it("destroy clears the cookie and the server entry", async () => {
    const store = new MemoryStore();
    const app = sessionApp(store);
    const login = await app.fetch(req("/login", { method: "POST" }));
    const pair = cookiePair(login, "mino-session") ?? "";
    const logout = await app.fetch(req("/logout", { method: "POST", headers: { cookie: pair } }));
    expect(logout.status).toBe(200);
    const cleared = setCookies(logout).find((s) => s.startsWith("mino-session="));
    expect(cleared).toContain("Max-Age=0");
    const me = await app.fetch(req("/me", { headers: { cookie: pair } }));
    expect(me.status).toBe(401);
  });

  it("regenerateSessionId rotates the id and preserves data", async () => {
    const store = new MemoryStore();
    const app = sessionApp(store);
    const regen = await app.fetch(req("/regen", { method: "POST" }));
    expect(regen.status).toBe(200);
    const body = (await regen.json()) as { before: string; after: string };
    expect(body.after).not.toBe(body.before);
    expect(generateSessionId()).not.toBe(generateSessionId());
    const pair = cookiePair(regen, "mino-session") ?? "";
    const me = await app.fetch(req("/me", { headers: { cookie: pair } }));
    expect(await me.json()).toMatchObject({ user: "ada" });
  });
});

describe("alpha: csrf edges", () => {
  it("handles quoted, multi-part, and undecodable cookies", async () => {
    const { app, downstream } = csrfApp();
    const { token } = await csrfPair(app);
    // Leading junk parts (no "=", wrong name) are skipped; quoted value is unwrapped.
    const res = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: {
          cookie: `flag; other=1; csrf-token="${encodeURIComponent(token)}"`,
          "x-csrf-token": token,
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(downstream.n).toBe(1);
    // Present-but-foreign cookie header → 403 (name lookup misses).
    const foreign = await app.fetch(
      req("/submit", { method: "POST", headers: { cookie: "other=1" } }),
    );
    expect(foreign.status).toBe(403);
    // Undecodable value is compared raw: echoed verbatim it passes …
    const raw = await app.fetch(
      req("/submit", { method: "POST", headers: { cookie: "csrf-token=%", "x-csrf-token": "%" } }),
    );
    expect(raw.status).toBe(200);
    // … but anything else fails the compare → 403.
    const bad = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: { cookie: "csrf-token=%", "x-csrf-token": "other" },
      }),
    );
    expect(bad.status).toBe(403);
  });

  it("supports custom cookie/header names and token length", async () => {
    const app = new Mino();
    app.use(csrf({ cookieName: "c", headerName: "h", tokenLength: 16 }));
    app.get("/", (c) => c.text("ok"));
    app.post("/submit", (c) => c.json({ ok: true }));
    const get = await app.fetch(req("/"));
    const token = tokenFrom(get, "c");
    expect(token?.length).toBe(16);
    const post = await app.fetch(
      req("/submit", { method: "POST", headers: { cookie: `c=${token}`, h: token ?? "" } }),
    );
    expect(post.status).toBe(200);
  });

  it("issues Secure cookies over https", async () => {
    const { app } = csrfApp();
    const res = await app.fetch(new Request("https://localhost/"));
    const set = cookiePair(res, "csrf-token") ?? "";
    expect(set.length).toBeGreaterThan("csrf-token=".length);
    expect(setCookies(res).some((s) => s.includes("; Secure"))).toBe(true);
  });

  it("keeps a downstream-set cookie instead of double-issuing", async () => {
    const app = new Mino();
    app.use(csrf());
    app.get("/preset", (c) => {
      c.headerSet("set-cookie", "other=1; Path=/");
      return c.text("ok");
    });
    app.get("/preset-empty", (c) => {
      c.headerSet("set-cookie", "csrf-token=; Path=/");
      return c.text("ok");
    });
    const both = await app.fetch(req("/preset"));
    const sets = setCookies(both);
    expect(sets.some((s) => s.startsWith("other="))).toBe(true);
    expect(
      sets.some((s) => s.startsWith("csrf-token=") && s.length > "csrf-token=; Path=/".length),
    ).toBe(true);
    // Downstream already set the csrf cookie (empty) → middleware does not append.
    const skip = await app.fetch(req("/preset-empty"));
    expect(setCookies(skip).filter((s) => s.startsWith("csrf-token=")).length).toBe(1);
  });

  it("rejects via the double-r Referer spelling too", async () => {
    const { app } = csrfApp();
    const { cookie, token } = await csrfPair(app);
    const res = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: { cookie, "x-csrf-token": token, referrer: "https://evil.test/x" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("void terminal handlers produce no cookie on safe methods", async () => {
    const app = new Mino();
    app.use(csrf());
    app.get("/void", () => undefined);
    const res = await app.fetch(req("/void"));
    expect(res.status).toBe(404);
    expect(cookiePair(res, "csrf-token")).toBeUndefined();
  });

  it("csrfWithStore validates constructor, rotation, liveness, and failures", async () => {
    expect(() => csrfWithStore(undefined as never)).toThrow();
    // Rotation: known cookie without a server record is replaced.
    const store = new MemoryStore();
    const app = new Mino();
    app.use(csrfWithStore({ store }));
    app.get("/", (c) => c.text("ok"));
    app.post("/submit", (c) => c.json({ ok: true }));
    const forged = generateCsrfToken();
    const rotated = await app.fetch(req("/", { headers: { cookie: `csrf-token=${forged}` } }));
    const fresh = tokenFrom(rotated, "csrf-token");
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(forged);
    // Liveness: a stored cookie is passed through without re-issue.
    const live = await app.fetch(req("/", { headers: { cookie: `csrf-token=${fresh}` } }));
    expect(live.status).toBe(200);
    expect(cookiePair(live, "csrf-token")).toBeUndefined();
    // Cross-origin with an otherwise valid pair is still rejected.
    const xorigin = await app.fetch(
      req("/submit", {
        method: "POST",
        headers: {
          cookie: `csrf-token=${fresh}`,
          "x-csrf-token": fresh ?? "",
          origin: "https://evil.test",
        },
      }),
    );
    expect(xorigin.status).toBe(403);
    // Storage failure on the unsafe path fails closed.
    const badStore = {
      get(): never {
        throw new Error("down");
      },
      set(): void {},
      destroy(): void {},
    };
    const app2 = new Mino();
    app2.use(csrfWithStore({ store: badStore }));
    app2.post("/submit", (c) => c.json({ ok: true }));
    const failed = await app2.fetch(
      req("/submit", { method: "POST", headers: { cookie: "csrf-token=x", "x-csrf-token": "x" } }),
    );
    expect(failed.status).toBe(403);
    // Void terminal handler: token is stored but there is no response to carry it.
    const app3 = new Mino();
    const s3 = new MemoryStore();
    app3.use(csrfWithStore({ store: s3 }));
    app3.get("/void", () => undefined);
    const voidRes = await app3.fetch(req("/void"));
    expect(voidRes.status).toBe(404);
    expect(s3.size).toBe(1);
    // Safe-path store read failure degrades to rotation, not a 500.
    const flaky = new MemoryStore();
    const app4 = new Mino();
    app4.use(
      csrfWithStore({
        store: {
          get(): never {
            throw new Error("down");
          },
          set: (id, data) => flaky.set(id, data),
          destroy: (id) => flaky.destroy(id),
        },
      }),
    );
    app4.get("/", (c) => c.text("ok"));
    const degraded = await app4.fetch(req("/", { headers: { cookie: "csrf-token=stale" } }));
    expect(degraded.status).toBe(200);
    expect(tokenFrom(degraded, "csrf-token")).toBeDefined();
  });

  it("tolerates runtimes without Headers.getSetCookie", async () => {
    const proto = Headers.prototype as unknown as Record<string, unknown>;
    const orig = proto["getSetCookie"];
    try {
      Reflect.deleteProperty(proto, "getSetCookie");
      const app = new Mino();
      app.use(csrf());
      app.get("/plain", (c) => c.text("ok"));
      app.get("/own", (c) => {
        c.headerSet("set-cookie", "other=1; Path=/");
        return c.text("ok");
      });
      const plain = await app.fetch(req("/plain"));
      expect(plain.headers.get("set-cookie")).toContain("csrf-token=");
      const own = await app.fetch(req("/own"));
      const combined = own.headers.get("set-cookie") ?? "";
      expect(combined).toContain("other=1");
      expect(combined).toContain("csrf-token=");
    } finally {
      proto["getSetCookie"] = orig;
    }
  });

  it("falls back through getRandomValues and Math.random token paths", async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
      Object.defineProperty(globalThis, "crypto", {
        value: {
          getRandomValues: (a: Uint8Array): Uint8Array => {
            a.fill(7);
            return a;
          },
        },
        configurable: true,
        writable: true,
      });
      expect(generateCsrfToken(8)).toBe("07070707");
      Object.defineProperty(globalThis, "crypto", {
        value: {},
        configurable: true,
        writable: true,
      });
      expect(generateCsrfToken(10).length).toBe(10);
      expect(generateSessionId().length).toBe(36);
    } finally {
      if (desc) Object.defineProperty(globalThis, "crypto", desc);
    }
  });
});

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign an arbitrary (possibly malformed-shape) payload with the session secret. */
async function craftSessionToken(payload: unknown, secret: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64url(new Uint8Array(sig))}`;
}

describe("alpha: session edges", () => {
  it("parses multi-part/quoted cookies, rejects undecodable and foreign ones", async () => {
    const app = sessionApp();
    const login = await app.fetch(req("/login", { method: "POST" }));
    const pair = cookiePair(login, "mino-session") ?? "";
    const value = pair.slice("mino-session=".length);
    const me = await app.fetch(
      req("/me", { headers: { cookie: `flag; other=1; mino-session="${value}"` } }),
    );
    expect(me.status).toBe(200);
    const undecodable = await app.fetch(req("/me", { headers: { cookie: "mino-session=%" } }));
    expect(undecodable.status).toBe(401);
    const foreign = await app.fetch(req("/me", { headers: { cookie: "other=1" } }));
    expect(foreign.status).toBe(401);
  });

  it("rejects malformed token shapes without throwing", async () => {
    const app = sessionApp();
    for (const bad of ["nodot", ".", "a.", ".b", "x.y"]) {
      const res = await app.fetch(req("/me", { headers: { cookie: `mino-session=${bad}` } }));
      expect(res.status).toBe(401);
    }
    // Valid signature, invalid shapes: non-object, bad sid/exp, bad data.
    for (const payload of [
      123,
      null,
      { sid: 1, exp: "x" },
      { sid: "a", exp: Date.now() + 1000, data: 5 },
      { sid: "a", exp: Date.now() + 1000, data: null },
      { sid: "a", exp: Date.now() + 1000, data: ["x"] },
      { sid: "a", exp: Date.now() + 1000 },
    ]) {
      const token = await craftSessionToken(payload, SECRET);
      const res = await app.fetch(req("/me", { headers: { cookie: `mino-session=${token}` } }));
      expect(res.status).toBe(401);
    }
    // Expired signature is fresh-started, not honored.
    const expired = await craftSessionToken(
      { sid: "old", data: { user: "root" }, exp: Date.now() - 1000 },
      SECRET,
    );
    const res = await app.fetch(req("/me", { headers: { cookie: `mino-session=${expired}` } }));
    expect(res.status).toBe(401);
  });

  it("supports custom cookie name and lifetime", async () => {
    const app = new Mino();
    app.use(session({ secret: SECRET, cookieName: "s2", maxAgeSec: 60 }));
    app.post("/login", (c) => {
      (c.get("session") as Record<string, unknown>)["user"] = "ada";
      return c.json({ ok: true });
    });
    app.get("/me", (c) => c.json({ user: (c.get("session") as Record<string, unknown>)["user"] }));
    const login = await app.fetch(req("/login", { method: "POST" }));
    const pair = cookiePair(login, "s2");
    expect(pair).toBeDefined();
    expect(cookiePair(login, "mino-session")).toBeUndefined();
    const me = await app.fetch(req("/me", { headers: { cookie: pair ?? "" } }));
    expect(await me.json()).toMatchObject({ user: "ada" });
  });

  it("sets Secure over https", async () => {
    const app = sessionApp();
    const login = await app.fetch(new Request("https://localhost/login", { method: "POST" }));
    expect(login.status).toBe(200);
    expect(setCookies(login).some((s) => s.includes("; Secure"))).toBe(true);
  });

  it("validates constructor secrets", () => {
    expect(() => session({ secret: "" })).toThrow();
    expect(() => session({} as never)).toThrow();
  });

  it("fails closed without WebCrypto", async () => {
    const app = sessionApp();
    const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
      Object.defineProperty(globalThis, "crypto", {
        value: {},
        configurable: true,
        writable: true,
      });
      const res = await app.fetch(req("/login", { method: "POST" }));
      expect(res.status).toBe(500);
    } finally {
      if (desc) Object.defineProperty(globalThis, "crypto", desc);
    }
  });

  it("tolerates store load failure and reports store save failure", async () => {
    // Load failure → fresh empty session (still 401 on /me, never 500).
    const failingLoad = {
      get(): never {
        throw new Error("down");
      },
      set(): void {},
      destroy(): void {},
    };
    const stateless = sessionApp();
    const login = await stateless.fetch(req("/login", { method: "POST" }));
    const pair = cookiePair(login, "mino-session") ?? "";
    const app = sessionApp(failingLoad as unknown as MemoryStore);
    const me = await app.fetch(req("/me", { headers: { cookie: pair } }));
    expect(me.status).toBe(401);
    // Save failure → explicit 500, not a silent drop.
    const failingSave = {
      get(): undefined {
        return undefined;
      },
      set(): never {
        throw new Error("down");
      },
      destroy(): void {},
    };
    const app2 = sessionApp(failingSave as unknown as MemoryStore);
    const res = await app2.fetch(req("/login", { method: "POST" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "session_store_error" });
  });

  it("tolerates store destroy failure but still clears the cookie", async () => {
    const evil = new MemoryStore();
    const origDestroy = evil.destroy.bind(evil);
    evil.destroy = (): never => {
      throw new Error("down");
    };
    const app = sessionApp(evil);
    const login = await app.fetch(req("/login", { method: "POST" }));
    const pair = cookiePair(login, "mino-session") ?? "";
    const logout = await app.fetch(req("/logout", { method: "POST", headers: { cookie: pair } }));
    expect(logout.status).toBe(200);
    expect(setCookies(logout).some((s) => s.includes("Max-Age=0"))).toBe(true);
    origDestroy("unused");
  });

  it("persists to the store even when there is no downstream response", async () => {
    const store = new MemoryStore();
    const app = new Mino();
    app.use(session({ secret: SECRET, store }));
    app.post("/mut", (c) => {
      (c.get("session") as Record<string, unknown>)["x"] = 1;
      c.set("sessionId", undefined);
    });
    const res = await app.fetch(req("/mut", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(store.size).toBe(1);
    // Destroy path without a response also stays silent (404, no throw).
    const app2 = new Mino();
    app2.use(session({ secret: SECRET, store: new MemoryStore() }));
    app2.post("/d", (c) => {
      c.set("session", null);
    });
    expect((await app2.fetch(req("/d", { method: "POST" }))).status).toBe(404);
  });

  it("recovers when the server record vanished but the signature is valid", async () => {
    const store = new MemoryStore();
    const app = sessionApp(store);
    const login = await app.fetch(req("/login", { method: "POST" }));
    const pair = cookiePair(login, "mino-session") ?? "";
    const raw = decodeURIComponent(pair.slice("mino-session=".length));
    const payloadB64 = raw.split(".")[0] ?? "";
    const sid = (
      JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))) as { sid: string }
    ).sid;
    store.destroy(sid);
    // Valid signature, no record → empty session, then a write re-persists it.
    expect((await app.fetch(req("/me", { headers: { cookie: pair } }))).status).toBe(401);
    const relogin = await app.fetch(req("/login", { method: "POST", headers: { cookie: pair } }));
    expect(relogin.status).toBe(200);
    const pair2 = cookiePair(relogin, "mino-session") ?? pair;
    expect((await app.fetch(req("/me", { headers: { cookie: pair2 } }))).status).toBe(200);
  });
});

describe("alpha: MemoryStore", () => {
  it("expires entries after TTL and prunes them on set", async () => {
    const store = new MemoryStore();
    store.set("k", { a: 1 }, 30);
    expect(store.get("k")).toEqual({ a: 1 });
    await sleep(60);
    expect(store.get("k")).toBeUndefined();
    store.set("gone", { a: 1 }, 30);
    await sleep(60);
    store.set("fresh", { b: 2 });
    expect(store.get("gone")).toBeUndefined();
    expect(store.get("fresh")).toEqual({ b: 2 });
  });

  it("evicts the oldest entry past maxEntries", () => {
    const store = new MemoryStore(3);
    store.set("a", { n: 1 });
    store.set("b", { n: 2 });
    store.set("c", { n: 3 });
    store.set("d", { n: 4 });
    expect(store.size).toBe(3);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("d")).toEqual({ n: 4 });
  });

  it("destroy removes entries", () => {
    const store = new MemoryStore();
    store.set("k", { a: 1 });
    store.destroy("k");
    expect(store.get("k")).toBeUndefined();
  });
});
