import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { Context } from "../src/context.js";
import { basic, safeEqualBasic } from "../src/basic-auth.js";
import { bearer } from "../src/bearer-auth.js";
import { withMethodOverride } from "../src/method-override.js";
import { trailingSlash } from "../src/trailing-slash.js";
import { trimPath } from "../src/trim-path.js";
import { vhost } from "../src/vhost.js";
import type { Handler } from "../src/types.js";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

// ─────────────────────────────────────────────────────────────────
// basic-auth
// ─────────────────────────────────────────────────────────────────

describe("track-a: basic-auth", () => {
  const mw = (verify: (u: string, p: string) => boolean | Promise<boolean>, realm?: string) => {
    const app = new Mino();
    app.use(realm !== undefined ? basic({ verify, realm }) : basic({ verify }));
    app.get("/me", (c) => c.json({ user: (c.get("basicUser") as { name: string }).name }));
    return app;
  };
  const creds = (u: string, p: string) => `Basic ${b64(`${u}:${p}`)}`;

  it("admits valid credentials and stores basicUser", async () => {
    const app = mw((u, p) => safeEqualBasic(u, "alice") && safeEqualBasic(p, "wonderland"));
    const res = await app.fetch(
      req("/me", { headers: { authorization: creds("alice", "wonderland") } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "alice" });
  });

  it("supports passwords containing colons (splits on FIRST colon)", async () => {
    let seen = "";
    const app = mw((u, p) => {
      seen = `${u}|${p}`;
      return true;
    });
    const res = await app.fetch(req("/me", { headers: { authorization: creds("bob", "a:b:c") } }));
    expect(res.status).toBe(200);
    expect(seen).toBe("bob|a:b:c");
  });

  it("rejects missing header with 401 + WWW-Authenticate + JSON code", async () => {
    const app = mw(() => true);
    const res = await app.fetch(req("/me"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"');
    expect(await res.json()).toEqual({ error: "Unauthorized", status: 401, code: "unauthorized" });
  });

  it("rejects wrong scheme with 401", async () => {
    const app = mw(() => true);
    const res = await app.fetch(req("/me", { headers: { authorization: "Bearer abc" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"');
  });

  it("uses a custom realm in the challenge", async () => {
    const app = mw(() => false, "Acme");
    const res = await app.fetch(req("/me"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Acme"');
  });

  it("rejects malformed base64 with 401", async () => {
    const app = mw(() => true);
    const res = await app.fetch(req("/me", { headers: { authorization: "Basic !!!" } }));
    expect(res.status).toBe(401);
  });

  it("rejects decoded credentials without a colon with 401", async () => {
    const app = mw(() => true);
    const res = await app.fetch(
      req("/me", { headers: { authorization: `Basic ${b64("nocolon")}` } }),
    );
    expect(res.status).toBe(401);
  });

  it("supports async verify", async () => {
    const app = mw(async (u, p) => u === "async" && p === "user");
    const ok = await app.fetch(req("/me", { headers: { authorization: creds("async", "user") } }));
    expect(ok.status).toBe(200);
    const bad = await app.fetch(req("/me", { headers: { authorization: creds("async", "nope") } }));
    expect(bad.status).toBe(401);
  });

  it("fails closed when verify throws", async () => {
    const app = mw(() => {
      throw new Error("db down");
    });
    const res = await app.fetch(req("/me", { headers: { authorization: creds("a", "b") } }));
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────
// bearer-auth
// ─────────────────────────────────────────────────────────────────

describe("track-a: bearer-auth", () => {
  const appWith = (mw: Handler, payloadProbe?: (c: unknown) => void) => {
    const app = new Mino();
    app.use(mw);
    app.get("/me", (c) => {
      payloadProbe?.(c);
      return c.json({ token: c.get("bearer") });
    });
    return app;
  };

  it("admits a token from the static list", async () => {
    const app = appWith(bearer({ tokens: ["tok-a", "tok-b"] }));
    const res = await app.fetch(req("/me", { headers: { authorization: "Bearer tok-b" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "tok-b" });
  });

  it("rejects a token outside the static list with 401 + Bearer challenge", async () => {
    const app = appWith(bearer({ tokens: ["tok-a"] }));
    const res = await app.fetch(req("/me", { headers: { authorization: "Bearer tok-zzz" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: "Unauthorized", status: 401, code: "unauthorized" });
  });

  it("matches the scheme case-insensitively", async () => {
    const app = appWith(bearer({ tokens: ["tok-a"] }));
    for (const scheme of ["bearer", "BEARER", "BeArEr"]) {
      const res = await app.fetch(req("/me", { headers: { authorization: `${scheme} tok-a` } }));
      expect(res.status).toBe(200);
    }
  });

  it("rejects a missing header with 401", async () => {
    const app = appWith(bearer({ tokens: ["tok-a"] }));
    const res = await app.fetch(req("/me"));
    expect(res.status).toBe(401);
  });

  it("admits via callback returning true", async () => {
    const app = appWith(bearer({ verify: (t) => t === "dyn-ok" }));
    const res = await app.fetch(req("/me", { headers: { authorization: "Bearer dyn-ok" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "dyn-ok" });
  });

  it("stashes a payload when verify returns an object", async () => {
    let payload: unknown;
    const app = appWith(
      bearer({ verify: async (t) => (t === "sess-1" ? { sub: "u1" } : false) }),
      (c) => {
        payload = (c as { get: (k: string) => unknown }).get("bearerPayload");
      },
    );
    const res = await app.fetch(req("/me", { headers: { authorization: "Bearer sess-1" } }));
    expect(res.status).toBe(200);
    expect(payload).toEqual({ sub: "u1" });
  });

  it("rejects via callback returning false, and fails closed on throw", async () => {
    const app = appWith(bearer({ verify: () => false }));
    expect((await app.fetch(req("/me", { headers: { authorization: "Bearer x" } }))).status).toBe(
      401,
    );
    const throwing = appWith(
      bearer({
        verify: () => {
          throw new Error("down");
        },
      }),
    );
    const res = await throwing.fetch(req("/me", { headers: { authorization: "Bearer x" } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("includes the realm in the challenge when configured", async () => {
    const app = appWith(bearer({ tokens: ["tok-a"], realm: "api" }));
    const res = await app.fetch(req("/me"));
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="api"');
  });

  it("throws without tokens or verify", () => {
    expect(() => bearer({})).toThrow("requires tokens or verify");
  });
});

// ─────────────────────────────────────────────────────────────────
// method-override (fetch-level wrapper)
// ─────────────────────────────────────────────────────────────────

describe("track-a: method-override", () => {
  const build = () => {
    const app = new Mino();
    app.post("/res", (c) => c.text("POST"));
    app.put("/res", (c) => c.text("PUT"));
    app.delete("/res", (c) => c.text("DELETE"));
    app.get("/res", (c) => c.text("GET"));
    app.put("/echo", async (c) => c.text(await c.textBody()));
    return app;
  };

  it("overrides via header", async () => {
    const fetch = withMethodOverride(build());
    const res = await fetch(
      req("/res", { method: "POST", headers: { "x-http-method-override": "PUT" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PUT");
  });

  it("overrides via ?_method= query param", async () => {
    const fetch = withMethodOverride(build());
    const res = await fetch(req("/res?_method=DELETE", { method: "POST" }));
    expect(await res.text()).toBe("DELETE");
  });

  it("prefers the header over the query param", async () => {
    const fetch = withMethodOverride(build());
    const res = await fetch(
      req("/res?_method=DELETE", {
        method: "POST",
        headers: { "x-http-method-override": "PUT" },
      }),
    );
    expect(await res.text()).toBe("PUT");
  });

  it("falls back to the query param when the header is empty", async () => {
    const fetch = withMethodOverride(build());
    const res = await fetch(
      req("/res?_method=DELETE", {
        method: "POST",
        headers: { "x-http-method-override": "" },
      }),
    );
    expect(await res.text()).toBe("DELETE");
  });

  it("ignores invalid overrides (never 4xx, proceeds as POST)", async () => {
    const fetch = withMethodOverride(build());
    const res = await fetch(req("/res?_method=BREW", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("POST");
  });

  it("leaves non-trigger methods untouched (GET + ?_method= stays GET)", async () => {
    const fetch = withMethodOverride(build());
    const res = await fetch(req("/res?_method=DELETE", { method: "GET" }));
    expect(await res.text()).toBe("GET");
  });

  it("passes POST through when no override is present", async () => {
    const fetch = withMethodOverride(build());
    const res = await fetch(req("/res", { method: "POST" }));
    expect(await res.text()).toBe("POST");
  });

  it("preserves the body across the rebuild", async () => {
    const fetch = withMethodOverride(build());
    const res = await fetch(
      req("/echo", {
        method: "POST",
        headers: { "content-type": "text/plain", "x-http-method-override": "PUT" },
        body: "hello-body",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-body");
  });

  it("supports custom header + disabled query", async () => {
    const fetch = withMethodOverride(build(), { header: "x-override", query: false });
    const viaHeader = await fetch(
      req("/res", { method: "POST", headers: { "x-override": "PUT" } }),
    );
    expect(await viaHeader.text()).toBe("PUT");
    const viaQuery = await fetch(req("/res?_method=PUT", { method: "POST" }));
    expect(await viaQuery.text()).toBe("POST");
  });
});

// ─────────────────────────────────────────────────────────────────
// trailing-slash
// ─────────────────────────────────────────────────────────────────

describe("track-a: trailing-slash", () => {
  const build = (mode: "always" | "never") => {
    const app = new Mino();
    app.use(trailingSlash(mode));
    app.get("/about", (c) => c.text("about"));
    app.get("/app.js", (c) => c.text("asset"));
    app.get("/", (c) => c.text("root"));
    return app;
  };

  it("always: redirects slashless paths to slashed 308", async () => {
    const res = await build("always").fetch(req("/about"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/about/");
  });

  it("always: preserves the query string", async () => {
    const res = await build("always").fetch(req("/about?x=1&y=2"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/about/?x=1&y=2");
  });

  it("always: passes canonical and file paths through", async () => {
    const app = build("always");
    expect((await app.fetch(req("/about/"))).status).toBe(200);
    const asset = await app.fetch(req("/app.js"));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("asset");
    expect((await app.fetch(req("/"))).status).toBe(200);
  });

  it("never: redirects slashed paths to slashless 308", async () => {
    const res = await build("never").fetch(req("/about/"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/about");
  });

  it("never: preserves the query string", async () => {
    const res = await build("never").fetch(req("/about/?x=1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/about?x=1");
  });

  it("never: passes canonical paths and root through", async () => {
    const app = build("never");
    expect((await app.fetch(req("/about"))).status).toBe(200);
    expect((await app.fetch(req("/"))).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────
// trim-path
// ─────────────────────────────────────────────────────────────────

describe("track-a: trim-path", () => {
  const build = () => {
    const app = new Mino();
    app.use(trimPath());
    app.get("/a/b", (c) => c.text("ab"));
    app.get("/a/", (c) => c.text("a-slash"));
    return app;
  };

  it("collapses duplicate slashes with 308", async () => {
    const res = await build().fetch(req("//a///b"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/a/b");
  });

  it("collapses /./ segments and trailing /. with 308", async () => {
    // NOTE: `new Request` normalizes dot segments client-side (WHATWG URL),
    // so dot-segment collapsing is exercised with a raw-URL Context — exactly
    // the decode-safe slice path production adapters feed in.
    const mw = trimPath();
    const runRaw = async (rawUrl: string) => {
      const res = await mw(new Context({ url: rawUrl } as Request), async () => {});
      expect(res).toBeInstanceOf(Response);
      return res as Response;
    };
    const dot = await runRaw("http://x/a/./b");
    expect(dot.status).toBe(308);
    expect(dot.headers.get("location")).toBe("/a/b");
    const nested = await runRaw("http://x/a/././b");
    expect(nested.headers.get("location")).toBe("/a/b");
    const trailing = await runRaw("http://x/a/.");
    expect(trailing.status).toBe(308);
    expect(trailing.headers.get("location")).toBe("/a/");
  });

  it("preserves the query string", async () => {
    const res = await build().fetch(req("//a//b?x=1"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/a/b?x=1");
  });

  it("passes canonical paths through untouched", async () => {
    const res = await build().fetch(req("/a/b"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ab");
  });

  it("never decodes: encoded dots pass through without redirect", async () => {
    const res = await build().fetch(req("/a/%2E%2E/b"));
    expect(res.status).not.toBe(308);
  });

  it("handles schemeless edge inputs via raw slices (no path, fragment)", async () => {
    const mw = trimPath();
    // Bare authority (no `/` after host) → root → canonical → next().
    let nextCalled = false;
    const bare = await mw(new Context({ url: "http://x" } as Request), async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(bare).toBeUndefined();
    // Fragment terminates the raw pathname slice.
    const frag = await mw(new Context({ url: "http://x//a#frag" } as Request), async () => {});
    expect(frag).toBeInstanceOf(Response);
    expect((frag as Response).headers.get("location")).toBe("/a");
  });
});

// ─────────────────────────────────────────────────────────────────
// vhost
// ─────────────────────────────────────────────────────────────────

describe("track-a: vhost", () => {
  const named = (name: string) => {
    const app = new Mino();
    app.get("/", (c) => c.text(name));
    return app;
  };

  it("dispatches by exact host", async () => {
    const front = vhost({ "a.example.com": named("A"), "b.example.com": named("B") });
    expect(await (await front(new Request("http://a.example.com/"))).text()).toBe("A");
    expect(await (await front(new Request("http://b.example.com/"))).text()).toBe("B");
  });

  it("matches case-insensitively and strips :port", async () => {
    const front = vhost({ "a.example.com": named("A") });
    expect(await (await front(new Request("http://a.example.com:8080/"))).text()).toBe("A");
    expect(await (await front(new Request("http://A.EXAMPLE.COM/"))).text()).toBe("A");
  });

  it("prefers the Host header over the URL host", async () => {
    const front = vhost({ "a.example.com": named("A") });
    const res = await front(
      new Request("http://fallback.test/", { headers: { host: "a.example.com" } }),
    );
    expect(await res.text()).toBe("A");
  });

  it("routes wildcards, most-specific wins, exact beats wildcard", async () => {
    const front = vhost({
      "*.example.com": named("WILD"),
      "*.foo.example.com": named("DEEP"),
      "x.foo.example.com": named("EXACT"),
    });
    expect(await (await front(new Request("http://other.example.com/"))).text()).toBe("WILD");
    expect(await (await front(new Request("http://y.foo.example.com/"))).text()).toBe("DEEP");
    expect(await (await front(new Request("http://x.foo.example.com/"))).text()).toBe("EXACT");
  });

  it("does not match the bare domain against a wildcard", async () => {
    const front = vhost({ "*.example.com": named("WILD") });
    const res = await front(new Request("http://example.com/"));
    expect(res.status).toBe(404);
  });

  it("answers 404 JSON with not_found code when unmatched", async () => {
    const front = vhost({ "a.example.com": named("A") });
    const res = await front(new Request("http://nope.test/"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found", status: 404, code: "not_found" });
  });

  it("delegates to the default app when given", async () => {
    const front = vhost({ "a.example.com": named("A") }, { default: named("DEFAULT") });
    expect(await (await front(new Request("http://nope.test/"))).text()).toBe("DEFAULT");
    expect(await (await front(new Request("http://a.example.com/"))).text()).toBe("A");
  });

  it("routes IPv6 literal hosts with ports stripped", async () => {
    // NOTE: stub target — Mino.fetch itself 400s bracketed hosts today
    // (`Bad host` guard), but the vhost dispatcher strips them correctly.
    const front = vhost({ "[::1]": { fetch: async () => new Response("V6") } });
    const res = await front(new Request("http://[::1]:3000/"));
    expect(await res.text()).toBe("V6");
  });
});
