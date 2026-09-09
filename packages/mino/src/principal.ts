/**
 * `@minostack/mino/principal` — enterprise identity context (plan P1.1/P1.5).
 *
 * Zero dependencies, runtime-agnostic. A `Principal` is the common shape every
 * auth mechanism (JWT, PASETO, bearer, basic, session, OIDC) populates, so
 * Mino middleware and Kernel guards can share one authorization model:
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { attachPrincipal, requireRole, audit } from "@minostack/mino/principal";
 *
 * const app = new Mino();
 * app.use(attachPrincipal((c) => principalFromJwt(c)));
 * app.get("/admin", requireRole("admin"), audit(sink, "admin.access"), (c) =>
 *   c.json({ ok: true }),
 * );
 * ```
 *
 * The principal is stored under `c.get("principal")` AND in a `WeakMap` keyed
 * by the Fetch `Request`, so Kernel guards (which only see `ctx.request`) can
 * read the same identity via `getRequestPrincipal(req)`. Nothing is logged
 * automatically — audit capture is explicit and redacted by construction.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";
import {
  MissingCredentialsError,
  MissingRoleError,
  MissingPermissionError,
  TenantForbiddenError,
} from "./errors.js";

export interface Principal {
  /** Stable subject id (user id, service name, device id) */
  subject: string;
  /** Tenant / organization the identity acts within */
  tenant?: string;
  roles: string[];
  permissions: string[];
  /** How the identity was established: "jwt" | "paseto" | "bearer" | "basic" | "session" | "oidc" | ... */
  authMethod?: string;
  /** Non-sensitive token metadata (issuer, expiry, key id — never the token) */
  tokenMeta?: Record<string, unknown>;
  /** Correlation ids (propagated, never logged with payloads) */
  requestId?: string;
  traceId?: string;
}

/** State key the principal is stored under (`c.get("principal")`). */
export const PRINCIPAL_KEY = "principal";

/** Request-keyed identity store shared with Kernel guards. */
const REQUEST_PRINCIPALS = new WeakMap<object, Principal>();

/** Read the principal for a Fetch request (Kernel-guard path). */
export function getRequestPrincipal(req: Request): Principal | undefined {
  return REQUEST_PRINCIPALS.get(req);
}

/** Attach a principal to the context (state + request map). */
export function setPrincipal(c: Context, p: Principal): void {
  c.set(PRINCIPAL_KEY, p);
  REQUEST_PRINCIPALS.set(c.req, p);
}

/** Read the principal from context state. */
export function getPrincipal(c: Context): Principal | undefined {
  return c.get(PRINCIPAL_KEY) as Principal | undefined;
}

/**
 * Resolve-and-attach middleware. `resolve` maps the request to a principal
 * (or `undefined` for anonymous). Never throws for anonymous — pair with
 * `requireAuth()` where authentication is mandatory.
 */
export function attachPrincipal(
  resolve: (c: Context) => Principal | undefined | Promise<Principal | undefined>,
): Handler {
  return async (c, next) => {
    const p = await resolve(c);
    if (p !== undefined) setPrincipal(c, p);
    await next();
  };
}

/** Reject anonymous requests with 401 `missing_credentials`. */
export function requireAuth(): Handler {
  return async (c, next) => {
    if (getPrincipal(c) === undefined) throw new MissingCredentialsError();
    await next();
  };
}

/** Require at least one of `roles`, else 403 `missing_role`. */
export function requireRole(...roles: string[]): Handler {
  return async (c, next) => {
    const p = getPrincipal(c);
    if (p === undefined) throw new MissingCredentialsError();
    if (!roles.some((r) => p.roles.includes(r))) throw new MissingRoleError();
    await next();
  };
}

/** Require all of `permissions`, else 403 `missing_permission`. */
export function requirePermission(...permissions: string[]): Handler {
  return async (c, next) => {
    const p = getPrincipal(c);
    if (p === undefined) throw new MissingCredentialsError();
    if (!permissions.every((perm) => p.permissions.includes(perm))) {
      throw new MissingPermissionError();
    }
    await next();
  };
}

/** Require the principal to act within `tenant`, else 403 `tenant_forbidden`. */
export function requireTenant(tenant: string): Handler {
  return async (c, next) => {
    const p = getPrincipal(c);
    if (p === undefined) throw new MissingCredentialsError();
    if (p.tenant !== tenant) throw new TenantForbiddenError();
    await next();
  };
}

// ─────────────────────────────────────────────────────────────────
// Audit (P1.5) — explicit, schema-stable, redacted by construction.
// Details are caller-supplied; request/response bodies are NEVER captured.
// ─────────────────────────────────────────────────────────────────

export interface AuditEvent {
  /** Stable event name, e.g. "auth.login", "admin.access", "job.completed" */
  type: string;
  /** ISO-8601 timestamp */
  at: string;
  actor?: string;
  tenant?: string;
  traceId?: string;
  requestId?: string;
  route?: string;
  outcome?: "allow" | "deny" | "error";
  /** Caller-supplied, must already be redacted — never tokens or payloads */
  details?: Record<string, unknown>;
}

export interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;
}

/** In-memory sink for dev/tests. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
  clear(): void {
    this.events.length = 0;
  }
}

export function createAuditEvent(
  type: string,
  opts: Omit<AuditEvent, "type" | "at"> & { at?: string } = {},
): AuditEvent {
  const { at, ...rest } = opts;
  return { type, at: at ?? new Date().toISOString(), ...rest };
}

/**
 * Audit middleware — records `type` after `next()` settles. Outcome derives
 * from the downstream status (2xx/3xx → allow, 401/403 → deny, else error).
 * Principal/route/correlation are picked up automatically when present.
 */
export function audit(sink: AuditSink, type: string): Handler {
  return async (c, next) => {
    let status = 500;
    try {
      await next();
      status = c.res?.status ?? 500;
    } catch (e) {
      // The dispatcher converts the throw to a response; record the outcome
      // from the thrown status instead of losing the audit trail.
      const s = (e as { status?: unknown })?.status;
      status = typeof s === "number" ? s : 500;
      throw e;
    } finally {
      const p = getPrincipal(c);
      await sink.record(
        createAuditEvent(type, {
          actor: p?.subject,
          tenant: p?.tenant,
          traceId: p?.traceId,
          requestId: p?.requestId,
          route: `${c.req.method} ${new URL(c.req.url).pathname}`,
          outcome: status < 400 ? "allow" : status === 401 || status === 403 ? "deny" : "error",
        }),
      );
    }
  };
}
