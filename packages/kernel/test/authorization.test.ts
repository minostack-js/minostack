import { describe, it, expect } from "vitest";
import { setPrincipal, type Principal } from "@minostack/mino/principal";
import { ExecutionContext } from "../src/execution-context.js";
import { Container } from "../src/container.js";
import { roleGuard, permissionGuard, tenantGuard, policyGuard } from "../src/authorization.js";
import { runGuards } from "../src/guards.js";

const ada: Principal = {
  subject: "ada",
  tenant: "acme",
  roles: ["admin"],
  permissions: ["users.write"],
};

function ctxWith(principal: Principal | undefined): ExecutionContext {
  const req = new Request("http://localhost/admin");
  if (principal) {
    // Kernel path: identity arrives via the request-keyed store (set by Mino middleware upstream)
    (setPrincipal as unknown as (c: unknown, p: Principal) => void)(
      { set: () => {}, req } as unknown,
      principal,
    );
  }
  return new ExecutionContext({
    request: req,
    route: { method: "GET", path: "/admin" },
    module: { name: "Test" },
    controller: { instance: {}, method: "x", handler: () => {} },
    container: new Container(),
  });
}

describe("kernel authorization guards (shared principal model)", () => {
  it("role/permission/tenant decisions match the Mino middleware model", async () => {
    const ctx = ctxWith(ada);
    expect(await runGuards([roleGuard("admin")], ctx)).toBe(true);
    expect(await runGuards([roleGuard("root")], ctx)).toBe(false);
    expect(await runGuards([permissionGuard("users.write")], ctx)).toBe(true);
    expect(await runGuards([permissionGuard("billing.read")], ctx)).toBe(false);
    expect(await runGuards([tenantGuard("acme")], ctx)).toBe(true);
    expect(await runGuards([tenantGuard("globex")], ctx)).toBe(false);
  });

  it("anonymous denies everywhere", async () => {
    const ctx = ctxWith(undefined);
    expect(await runGuards([roleGuard("admin")], ctx)).toBe(false);
    expect(await runGuards([permissionGuard("users.write")], ctx)).toBe(false);
    expect(await runGuards([tenantGuard("acme")], ctx)).toBe(false);
  });

  it("policyGuard supports ABAC decisions", async () => {
    const ctx = ctxWith(ada);
    const ownerOnly = policyGuard((p) => p?.subject === "ada");
    expect(await runGuards([ownerOnly], ctx)).toBe(true);
    expect(await runGuards([policyGuard(() => false)], ctx)).toBe(false);
  });
});
