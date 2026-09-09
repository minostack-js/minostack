import { describe, it, expect } from "vitest";
import { Mino, defineRoute, contractClient } from "../src/index.js";
import { versioned, versionPrefix, sunset } from "../src/versioning.js";
import { m } from "@minostack/schema";

describe("P4: URL versioning", () => {
  it("versions coexist under /v1 and /v2 with correct route graph", async () => {
    const app = new Mino();
    const v1 = versioned(app, "v1");
    v1.get("/users", (c) => c.json({ v: 1 }));
    const v2 = versioned(app, 2);
    v2.get("/users", (c) => c.json({ v: 2 }));
    v2.get("/", (c) => c.text("root"));
    expect(v1.prefix).toBe("/v1");
    expect(versionPrefix("v3")).toBe("/v3");
    expect(await (await app.fetch(new Request("http://localhost/v1/users"))).json()).toEqual({
      v: 1,
    });
    expect(await (await app.fetch(new Request("http://localhost/v2/users"))).json()).toEqual({
      v: 2,
    });
    expect(await (await app.fetch(new Request("http://localhost/v2"))).text()).toBe("root");
    const paths = app.getRoutes().map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("GET /v1/users");
    expect(paths).toContain("GET /v2/users");
  });

  it("versioned middleware is path-scoped", async () => {
    const app = new Mino();
    const v1 = versioned(app, "v1");
    v1.use((c, next) => {
      c.headerSet("x-v", "1");
      return next();
    });
    v1.get("/a", (c) => c.text("a"));
    app.get("/b", (c) => c.text("b"));
    expect((await app.fetch(new Request("http://localhost/v1/a"))).headers.get("x-v")).toBe("1");
    expect((await app.fetch(new Request("http://localhost/b"))).headers.get("x-v")).toBeNull();
  });

  it("sunset advertises deprecation without changing behavior", async () => {
    const app = new Mino();
    app.get("/old", sunset({ date: "2027-01-01", successor: "/v2/old" }), (c) => c.text("old"));
    app.get("/plain", sunset({ date: "2027-06-01", deprecation: false }), (c) => c.text("p"));
    const r1 = await app.fetch(new Request("http://localhost/old"));
    expect(await r1.text()).toBe("old");
    expect(r1.headers.get("deprecation")).toBe("true");
    expect(r1.headers.get("sunset")).toBe("2027-01-01");
    expect(r1.headers.get("link")).toBe('</v2/old>; rel="successor-version"');
    const r2 = await app.fetch(new Request("http://localhost/plain"));
    expect(r2.headers.get("deprecation")).toBeNull();
    expect(r2.headers.get("sunset")).toBe("2027-06-01");
  });
});

describe("P4: contract client", () => {
  const CreateUser = defineRoute({
    method: "POST",
    path: "/v1/users",
    input: m.object({ name: m.string().min(2) }),
    operation: { operationId: "createUser", summary: "Create user" },
  });

  it("drives calls from contracts without duplicated paths", async () => {
    const seen: string[] = [];
    const client = contractClient("https://api.example.com", [CreateUser], {
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push(`${init?.method} ${url} ${init?.body}`);
        return new Response('{"id":"1"}', { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    const res = await client.createUser?.({ json: { name: "Ada" } });
    expect(res?.status).toBe(200);
    expect(seen).toEqual(['POST https://api.example.com/v1/users {"name":"Ada"}']);
  });

  it("substitutes params/query and validates input when asked", async () => {
    const GetUser = defineRoute({
      method: "GET",
      path: "/v1/users/:id",
      operation: { operationId: "getUser" },
    });
    const seen: string[] = [];
    const client = contractClient("https://api.example.com/", [GetUser, CreateUser], {
      validateInput: true,
      fetch: (async (url: string) => {
        seen.push(url);
        return new Response("{}");
      }) as typeof fetch,
    });
    await client.getUser?.({ params: { id: "42" }, query: { verbose: "1" } });
    expect(seen[0]).toBe("https://api.example.com/v1/users/42?verbose=1");
    await expect(client.createUser?.({ json: { name: "x" } })).rejects.toThrow(
      /Contract input invalid/,
    );
    expect(seen).toHaveLength(1);
  });

  it("requires operationId on every contract", () => {
    expect(() => contractClient("https://x.example.com", [{ method: "GET", path: "/a" }])).toThrow(
      /operationId/,
    );
  });
});
