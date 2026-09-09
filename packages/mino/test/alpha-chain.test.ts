import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { sign } from "../src/jwt.js";
import { jwt } from "../src/jwt.js";
import { csrf } from "../src/csrf.js";
import { session } from "../src/session.js";
import { compress } from "../src/compress.js";
import { etag } from "../src/etag.js";

/**
 * alpha-chain: proves the preview sub-paths compose in one pipeline —
 * session → csrf → jwt → handler, wrapped by compress + etag.
 */
const SECRET = "chain-test-secret-1234567890";

function buildApp(): Mino {
  const app = new Mino();
  app.use(compress({ threshold: 1 }));
  app.use(etag());
  app.use(session({ secret: SECRET }));
  app.use(csrf());
  app.use(jwt({ secret: SECRET }));
  app.get("/me", (c) => c.json({ sub: (c.get("jwtPayload") as { sub: string }).sub }));
  app.post("/update", (c) => {
    const sess = c.get("session") as Record<string, unknown>;
    const visits = ((sess["visits"] as number) ?? 0) + 1;
    sess["visits"] = visits;
    return c.json({ ok: true, visits });
  });
  return app;
}

async function establish(app: Mino): Promise<{ jar: string; csrfTok: string }> {
  const token = await sign({ sub: "u1" }, SECRET);
  const first = await app.fetch(
    new Request("http://localhost/me", { headers: { authorization: `Bearer ${token}` } }),
  );
  expect(first.status).toBe(200);
  const cookies = first.headers.getSetCookie ? first.headers.getSetCookie() : [];
  const jar = cookies.map((s) => s.split(";")[0]).join("; ");
  const csrfTok = (jar.match(/csrf-token=([^;]+)/) ?? [])[1] ?? "";
  expect(csrfTok.length).toBeGreaterThan(0);
  return { jar, csrfTok };
}

describe("alpha-chain: session+csrf+jwt+compress+etag", () => {
  it("unsafe POST without csrf token → 403, downstream never runs", async () => {
    const app = buildApp();
    const { jar } = await establish(app);
    const token = await sign({ sub: "u1" }, SECRET);
    const res = await app.fetch(
      new Request("http://localhost/update", {
        method: "POST",
        headers: { cookie: jar, authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "csrf_failed" });
  });

  it("unsafe POST with bad jwt → 401", async () => {
    const app = buildApp();
    const { jar, csrfTok } = await establish(app);
    const res = await app.fetch(
      new Request("http://localhost/update", {
        method: "POST",
        headers: {
          cookie: jar,
          authorization: "Bearer tampered.token.here",
          "x-csrf-token": csrfTok,
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("valid token + csrf token → 200, session persists, gzip + etag applied", async () => {
    const app = buildApp();
    const { jar, csrfTok } = await establish(app);
    const token = await sign({ sub: "u1" }, SECRET);
    const base = {
      cookie: jar,
      authorization: `Bearer ${token}`,
      "x-csrf-token": csrfTok,
    };
    const r1 = await app.fetch(
      new Request("http://localhost/update", { method: "POST", headers: base }),
    );
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, visits: 1 });
    expect(r1.headers.get("etag")).toContain("-");
    const r2 = await app.fetch(
      new Request("http://localhost/update", {
        method: "POST",
        headers: { ...base, "accept-encoding": "gzip" },
      }),
    );
    expect(r2.status).toBe(200);
    expect(r2.headers.get("content-encoding")).toBe("gzip");
    // Compressed bytes differ from what etag hashed, so compress drops the
    // stale ETag rather than serving a wrong one.
    expect(r2.headers.get("etag")).toBe(null);
  });
});
