/**
 * Enterprise: multi-tenant SaaS module shape (dev-mode preview).
 *
 * One Mino app, tenant-scoped principals, Kernel guards enforcing the same
 * policy through HTTP and through the container.
 *
 * Expected: acme key reads acme billing; globex key or missing role → 403.
 */

import { Mino } from "@minostack/mino";
import {
  attachPrincipal,
  requireRole,
  requireTenant,
  type Principal,
} from "@minostack/mino/principal";
import { tenantGuard, runGuards, createTestContext } from "@minostack/kernel";

const PRINCIPALS: Record<string, Principal> = {
  "acme-key": {
    subject: "acme-admin",
    tenant: "acme",
    roles: ["billing.read"],
    permissions: [],
    authMethod: "bearer",
  },
  "globex-key": {
    subject: "globex-admin",
    tenant: "globex",
    roles: ["billing.read"],
    permissions: [],
    authMethod: "bearer",
  },
};

export const app = new Mino();

app.use(
  attachPrincipal((c) => {
    const key = c.req.headers.get("x-api-key") ?? "";
    return PRINCIPALS[key];
  }),
);

app.get("/billing", requireRole("billing.read"), requireTenant("acme"), (c) =>
  c.json({ tenant: "acme", total: 42 }),
);

/** Same tenant policy through the Kernel guard layer (services/jobs). */
export async function kernelCanReadBilling(principal: Principal | undefined): Promise<boolean> {
  const ctx = createTestContext({ principal });
  return runGuards([tenantGuard("acme")], ctx);
}

export function principalFor(apiKey: string): Principal | undefined {
  return PRINCIPALS[apiKey];
}

export async function authedFetch(apiKey: string, path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { headers: { "x-api-key": apiKey } }));
}
