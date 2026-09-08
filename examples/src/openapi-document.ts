/**
 * OpenAPI: `oas31` converts one schema to an OAS 3.1 Schema Object;
 * `document31` wraps named roots in a publishable document. Approximations
 * (regexes, refinements, unions of scalars) are never silent — each adds a
 * `{ code, path, message }` warning.
 *
 * Expected: `openapi` is `"3.1.0"` with components `User` + `Status`;
 * the `search` pattern survives as `pattern: "^adm"`.
 */

import { m } from "@minostack/schema";
import { document31, oas31 } from "@minostack/openapi";

export const Status = m.enum(["active", "banned"]);

export const User = m.object({
  id: m.string().uuid(),
  name: m.string().min(2),
  status: Status,
  search: m.string().startsWith("adm").optional(),
});

export const userSchema = oas31(User);
export const api = document31({ title: "Users API", version: "1.0.0" }, { User, Status });
