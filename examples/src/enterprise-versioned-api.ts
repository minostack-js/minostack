/**
 * Enterprise: URL-versioned public API with deprecation + compat checks.
 *
 * Expected: /v1 and /v2 coexist; /v1 advertises Sunset; removing a route
 * shows up as breaking in `diffRoutes`.
 */

import { Mino, defineRoute } from "@minostack/mino";
import { versioned, sunset } from "@minostack/mino/versioning";
import { generateMinoDocument } from "@minostack/openapi";
import { diffRoutes, assertCompatible } from "@minostack/openapi";
import { m } from "@minostack/schema";

export const app = new Mino();

const v1 = versioned(app, "v1");
v1.get("/users", sunset({ date: "2027-01-01", successor: "/v2/users" }), (c) =>
  c.json([{ id: "1", name: "Ada" }]),
);

const v2 = versioned(app, "v2");
v2.get("/users", (c) => c.json([{ id: "1", name: "Ada", email: "ada@example.com" }]));

const UserV1 = m.object({ id: m.string(), name: m.string() });

export const GetUsersV1 = defineRoute({
  method: "GET",
  path: "/v1/users",
  output: UserV1,
  operation: { operationId: "listUsersV1", summary: "List users (v1)", deprecated: true },
});

export const { document } = generateMinoDocument(
  app,
  { title: "Users API", version: "2.0.0" },
  { UserV1 },
  { routeMap: { "GET /v1/users": { output: UserV1, operation: GetUsersV1.operation } } },
);

const v1Routes = app.getRoutes().filter((r) => r.path.startsWith("/v1"));

export const compatReport = diffRoutes(
  v1Routes.map((r) => ({ method: r.method, path: r.path })),
  app.getRoutes().map((r) => ({ method: r.method, path: r.path })),
);

export const additiveOnly = assertCompatible(
  [{ method: "GET", path: "/v1/users" }],
  [
    { method: "GET", path: "/v1/users" },
    { method: "GET", path: "/v2/users" },
  ],
);
