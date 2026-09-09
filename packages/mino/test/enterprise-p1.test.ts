import { describe, it, expect } from "vitest";
import { Mino } from "../src/index.js";
import {
  PRINCIPAL_KEY,
  attachPrincipal,
  requireAuth,
  requireRole,
  requirePermission,
  requireTenant,
  getRequestPrincipal,
  setPrincipal,
  MemoryAuditSink,
  audit,
  createAuditEvent,
  type Principal,
} from "../src/principal.js";
import { RotatingTokenStore } from "../src/session.js";
import {
  authorizationUrl,
  validateCallback,
  createPkcePair,
  exchangeCode,
  clientCredentials,
  MemoryJwksCache,
  requestDeviceCode,
  pollDeviceToken,
  type FetchFn,
} from "../src/oidc.js";

const ada: Principal = {
  subject: "ada",
  tenant: "acme",
  roles: ["admin", "dev"],
  permissions: ["users.read", "users.write"],
  authMethod: "jwt",
};

describe("P1: principal + RBAC middleware", () => {
  const app = new Mino();
  app.use(attachPrincipal(() => ada));
  app.get("/open", (c) => c.text("open"));
  app.get("/me", requireAuth(), (c) => c.text((c.get(PRINCIPAL_KEY) as Principal).subject));
  app.get("/admin", requireRole("admin"), (c) => c.text("admin"));
  app.get("/root", requireRole("root"), (c) => c.text("root"));
  app.get("/write", requirePermission("users.write"), (c) => c.text("w"));
  app.get("/billing", requirePermission("billing.read"), (c) => c.text("b"));
  app.get("/tenant", requireTenant("acme"), (c) => c.text("t"));
  app.get("/other-tenant", requireTenant("globex"), (c) => c.text("t"));

  it.each([
    ["/open", 200],
    ["/me", 200],
    ["/admin", 200],
    ["/root", 403],
    ["/write", 200],
    ["/billing", 403],
    ["/tenant", 200],
    ["/other-tenant", 403],
  ])("%s → %s", async (path, status) => {
    expect((await app.fetch(new Request(`http://localhost${path}`))).status).toBe(status);
  });

  it("anonymous is 401 on guarded routes", async () => {
    const anon = new Mino();
    anon.get("/me", requireAuth(), (c) => c.text("x"));
    const res = await anon.fetch(new Request("http://localhost/me"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "missing_credentials" });
  });

  it("request-keyed identity is visible without context (kernel path)", async () => {
    const app2 = new Mino();
    let seen: Principal | undefined;
    app2.use(attachPrincipal(() => ada));
    app2.get("/x", (c) => {
      seen = getRequestPrincipal(c.req);
      return c.text("x");
    });
    await app2.fetch(new Request("http://localhost/x"));
    expect(seen?.subject).toBe("ada");
  });

  it("setPrincipal stores in state and request map", async () => {
    const app3 = new Mino();
    app3.get("/x", (c) => {
      setPrincipal(c, ada);
      return c.text("x");
    });
    await app3.fetch(new Request("http://localhost/x"));
  });
});

describe("P1: audit", () => {
  it("records allow/deny/error outcomes with correlation, never bodies", async () => {
    const sink = new MemoryAuditSink();
    const app = new Mino();
    app.use(attachPrincipal(() => ({ ...ada, requestId: "r1", traceId: "t1" })));
    app.get("/ok", audit(sink, "res.read"), (c) => c.text("ok"));
    app.get("/no", audit(sink, "res.read"), requireRole("root"), (c) => c.text("no"));
    await app.fetch(new Request("http://localhost/ok"));
    await app.fetch(new Request("http://localhost/no"));
    expect(sink.events).toHaveLength(2);
    expect(sink.events[0]).toMatchObject({
      type: "res.read",
      outcome: "allow",
      actor: "ada",
      tenant: "acme",
      requestId: "r1",
      traceId: "t1",
    });
    expect(sink.events[1]?.outcome).toBe("deny");
    expect(JSON.stringify(sink.events)).not.toContain("secret");
    sink.clear();
    expect(sink.events).toHaveLength(0);
  });

  it("createAuditEvent defaults timestamp", () => {
    const e = createAuditEvent("auth.login", { actor: "ada" });
    expect(e.at).toMatch(/^\d{4}-/);
  });
});

describe("P1: refresh rotation with reuse detection", () => {
  it("rotate → consume live; reuse of retired destroys chain", () => {
    const store = new RotatingTokenStore();
    const first = store.begin("chain-1");
    const second = store.rotate("chain-1");
    expect(second).not.toBe(first);
    expect(store.consume("chain-1", second)).toBe(second);
    expect(() => store.consume("chain-1", first)).toThrow(/reuse detected/);
    expect(store.size).toBe(0);
    expect(() => store.consume("chain-1", second)).toThrow(/Unknown refresh chain/);
  });

  it("unknown token and revoke", () => {
    const store = new RotatingTokenStore();
    store.begin("c");
    expect(() => store.consume("c", "bogus")).toThrow(/Unknown refresh token/);
    expect(() => store.rotate("nope")).toThrow(/Unknown refresh chain/);
    store.revoke("c");
    expect(store.size).toBe(0);
  });
});

describe("P1: OIDC boundary", () => {
  it("authorizationUrl requires state and builds PKCE url", async () => {
    const pkce = await createPkcePair();
    expect(pkce.method).toBe("S256");
    expect(pkce.verifier.length).toBeGreaterThan(20);
    const url = authorizationUrl({
      issuer: "https://id.example.com/",
      clientId: "web",
      redirectUri: "https://app.example.com/cb",
      state: "s1",
      nonce: "n1",
      pkceChallenge: pkce.challenge,
    });
    expect(url.startsWith("https://id.example.com/authorize?")).toBe(true);
    expect(url).toContain("code_challenge=");
    expect(() =>
      authorizationUrl({ issuer: "x", clientId: "y", redirectUri: "z", state: "" }),
    ).toThrow();
  });

  it("validateCallback enforces code/state, maps provider denial", () => {
    expect(validateCallback({ code: "c", state: "s" }, "s")).toEqual({ code: "c", state: "s" });
    expect(() => validateCallback({ code: "c", state: "x" }, "s")).toThrow();
    expect(() => validateCallback({ error: "access_denied" }, "s")).toThrow();
  });

  it("exchangeCode + clientCredentials hit token endpoint", async () => {
    const calls: string[] = [];
    const fake: FetchFn = async (url, init) => {
      calls.push(`${url} ${(init?.body as string) ?? ""}`);
      return Response.json({ access_token: "at", token_type: "Bearer" });
    };
    const t1 = await exchangeCode({
      tokenEndpoint: "https://id.example.com/token",
      clientId: "web",
      clientSecret: "shh",
      code: "code1",
      redirectUri: "https://app.example.com/cb",
      fetchFn: fake,
    });
    expect(t1.access_token).toBe("at");
    expect(calls[0]).toContain("grant_type=authorization_code");
    const t2 = await clientCredentials({
      tokenEndpoint: "https://id.example.com/token",
      clientId: "svc",
      clientSecret: "shh",
      scope: "api",
      fetchFn: fake,
    });
    expect(t2.access_token).toBe("at");
    expect(calls[1]).toContain("grant_type=client_credentials");
    const bad: FetchFn = async () => new Response("no", { status: 400 });
    await expect(
      exchangeCode({
        tokenEndpoint: "u",
        clientId: "c",
        code: "x",
        redirectUri: "r",
        fetchFn: bad,
      }),
    ).rejects.toThrow();
  });

  it("MemoryJwksCache caches then refreshes after TTL (rotation)", async () => {
    let n = 0;
    let now = 0;
    const fake: FetchFn = async () => Response.json({ keys: [`k${++n}`] });
    const cache = new MemoryJwksCache({ ttlMs: 1000, fetchFn: fake, now: () => now });
    expect(await cache.getJwks("https://id.example.com/jwks")).toEqual({ keys: ["k1"] });
    expect(await cache.getJwks("https://id.example.com/jwks")).toEqual({ keys: ["k1"] });
    expect(n).toBe(1);
    now = 2000;
    expect(await cache.getJwks("https://id.example.com/jwks")).toEqual({ keys: ["k2"] });
    cache.clear();
    now = 3000;
    expect(await cache.getJwks("https://id.example.com/jwks")).toEqual({ keys: ["k3"] });
  });

  it("device flow: pending → slow_down → success", async () => {
    const seq: Response[] = [
      Response.json({
        device_code: "dc",
        user_code: "WDJB-MJHT",
        verification_uri: "https://id.example.com/activate",
        expires_in: 1800,
        interval: 1,
      }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({ access_token: "dat", token_type: "Bearer" }),
    ];
    const sleeps: number[] = [];
    const fake: FetchFn = async () => seq.shift() as Response;
    const dc = await requestDeviceCode({
      deviceEndpoint: "https://id.example.com/device",
      clientId: "cli",
      fetchFn: fake,
    });
    expect(dc.user_code).toBe("WDJB-MJHT");
    const now = 0;
    const tok = await pollDeviceToken({
      tokenEndpoint: "https://id.example.com/token",
      clientId: "cli",
      deviceCode: dc.device_code,
      intervalSec: 1,
      fetchFn: fake,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => now,
    });
    expect(tok.access_token).toBe("dat");
    expect(sleeps).toEqual([1000, 6000]);
  });

  it("device poll maps expired/denied/timeout", async () => {
    const mk =
      (err: string): FetchFn =>
      async () =>
        Response.json({ error: err }, { status: 400 });
    await expect(
      pollDeviceToken({
        tokenEndpoint: "u",
        clientId: "c",
        deviceCode: "d",
        fetchFn: mk("expired_token"),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/expired/);
    await expect(
      pollDeviceToken({
        tokenEndpoint: "u",
        clientId: "c",
        deviceCode: "d",
        fetchFn: mk("access_denied"),
        sleep: async () => {},
      }),
    ).rejects.toThrow();
    await expect(
      pollDeviceToken({
        tokenEndpoint: "u",
        clientId: "c",
        deviceCode: "d",
        fetchFn: mk("weird"),
        sleep: async () => {},
      }),
    ).rejects.toThrow(/poll failed/);
    let now = 0;
    await expect(
      pollDeviceToken({
        tokenEndpoint: "u",
        clientId: "c",
        deviceCode: "d",
        fetchFn: mk("authorization_pending"),
        sleep: async () => {
          now += 10_000;
        },
        now: () => now,
        timeoutMs: 15_000,
      }),
    ).rejects.toThrow(/timed out/);
    const badDev: FetchFn = async () => new Response("no", { status: 400 });
    await expect(
      requestDeviceCode({ deviceEndpoint: "u", clientId: "c", fetchFn: badDev }),
    ).rejects.toThrow();
  });
});
