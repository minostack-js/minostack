/**
 * Authorization — Kernel-side policy guards over the shared Mino principal.
 * Per plan P1.4: the same identity model works through Mino middleware
 * (`mino/principal`) and Kernel guards (here), because both read
 * `getRequestPrincipal(ctx.request)`.
 *
 * ```ts
 * import { roleGuard, permissionGuard, tenantGuard } from "@minostack/kernel";
 *
 * @useGuards(roleGuard("admin"))
 * @get("/admin")
 * admin() { ... }
 * ```
 */

import { getRequestPrincipal, type Principal } from "@minostack/mino/principal";
import type { Guard } from "./guards.js";
import type { ExecutionContext } from "./execution-context.js";

function principalOf(ctx: ExecutionContext): Principal | undefined {
  return getRequestPrincipal(ctx.request as Request);
}

/** Allow when the principal holds at least one of `roles`. Anonymous denies. */
export function roleGuard(...roles: string[]): Guard {
  return {
    canActivate(ctx: ExecutionContext): boolean {
      const p = principalOf(ctx);
      if (p === undefined) return false;
      return roles.some((r) => p.roles.includes(r));
    },
  };
}

/** Allow when the principal holds all of `permissions`. Anonymous denies. */
export function permissionGuard(...permissions: string[]): Guard {
  return {
    canActivate(ctx: ExecutionContext): boolean {
      const p = principalOf(ctx);
      if (p === undefined) return false;
      return permissions.every((perm) => p.permissions.includes(perm));
    },
  };
}

/** Allow when the principal acts within `tenant`. Anonymous denies. */
export function tenantGuard(tenant: string): Guard {
  return {
    canActivate(ctx: ExecutionContext): boolean {
      return principalOf(ctx)?.tenant === tenant;
    },
  };
}

/**
 * Attribute-based policy guard. `decide` receives the principal (or
 * `undefined` for anonymous) plus the execution context and returns the
 * decision. Keep decisions pure and log-free; audit at the call site.
 */
export function policyGuard(
  decide: (principal: Principal | undefined, ctx: ExecutionContext) => boolean | Promise<boolean>,
): Guard {
  return {
    canActivate(ctx: ExecutionContext): boolean | Promise<boolean> {
      return decide(principalOf(ctx), ctx);
    },
  };
}
