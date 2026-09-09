import { describe, it, expect } from "vitest";
import {
  bearerAuth,
  apiKeyAuth,
  oidcAuth,
  oauth2Auth,
  diffRoutes,
  assertCompatible,
} from "../src/compat.js";

describe("openapi enterprise: security + compatibility", () => {
  it("builds scheme fragments", () => {
    const b = bearerAuth();
    expect(b.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(b.security).toEqual([{ bearerAuth: [] }]);
    expect(apiKeyAuth("x-key", "header").securitySchemes.apiKeyAuth).toMatchObject({
      type: "apiKey",
    });
    expect(oidcAuth("https://id.example.com/.well-known").securitySchemes.oidc).toMatchObject({
      type: "openIdConnect",
    });
    expect(
      oauth2Auth({ clientCredentials: { tokenUrl: "https://id.example.com/token" } })
        .securitySchemes.oauth2,
    ).toMatchObject({
      type: "oauth2",
    });
  });

  it("diffs route graphs into breaking/additive", () => {
    const prev = [
      { method: "GET", path: "/v1/users" },
      { method: "POST", path: "/v1/users" },
      { method: "get", path: "/v1/old" },
    ];
    const next = [
      { method: "GET", path: "/v1/users" },
      { method: "GET", path: "/v2/users" },
    ];
    const diff = diffRoutes(prev, next);
    expect(diff.breaking).toEqual(["removed POST /v1/users", "removed GET /v1/old"]);
    expect(diff.additive).toEqual(["added GET /v2/users"]);
    expect(diff.unchanged).toBe(1);
    expect(() => assertCompatible(prev, next)).toThrow(/Breaking API changes/);
    expect(assertCompatible(next, next)).toEqual([]);
    const additive = assertCompatible(
      [{ method: "GET", path: "/a" }],
      [
        { method: "GET", path: "/a" },
        { method: "GET", path: "/b" },
      ],
    );
    expect(additive).toEqual(["added GET /b"]);
  });
});
