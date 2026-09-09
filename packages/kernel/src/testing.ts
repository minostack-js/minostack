/**
 * Testing helpers (plan P6.1/P6.3) — deterministic enterprise tests.
 *
 * - `testApp(rootModule)` boots the module graph for tests (just
 *   `Application.create` with a closing-friendly shape).
 * - `createTestContext(...)` builds an `ExecutionContext` for guard/pipe
 *   tests and can seed the shared principal (same store Mino middleware and
 *   Kernel guards read).
 * - `fixedClock`, `counterIds`, `testPrincipal`, `fakeFetch` are deterministic
 *   doubles for time, ids, identity, and upstream HTTP.
 */

import { setPrincipal, type Principal } from "@minostack/mino/principal";
import { Application, type ApplicationOptions } from "./application.js";
import type { ModuleClass } from "./module.js";
import { Container } from "./container.js";
import { ExecutionContext } from "./execution-context.js";

/** Boot the module graph for a test. Execute HTTP via `app.fetch`. */
export async function testApp(
  rootModule: ModuleClass,
  opts: ApplicationOptions = {},
): Promise<Application> {
  return Application.create(rootModule, opts);
}

/** Canonical test identity — override what you need per test. */
export function testPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    subject: "test-user",
    tenant: "test-tenant",
    roles: [],
    permissions: [],
    authMethod: "test",
    ...overrides,
  };
}

/**
 * Build an `ExecutionContext` for guard/interceptor tests. When `principal`
 * is given it is seeded into the request-keyed store, exactly as Mino's
 * `attachPrincipal` middleware would do upstream.
 */
export function createTestContext(
  opts: {
    request?: Request;
    method?: string;
    path?: string;
    principal?: Principal;
    container?: Container;
  } = {},
): ExecutionContext {
  const request = opts.request ?? new Request(`http://localhost${opts.path ?? "/test"}`);
  if (opts.principal) {
    setPrincipal({ set: () => {}, req: request } as never, opts.principal);
  }
  return new ExecutionContext({
    request,
    route: { method: opts.method ?? "GET", path: opts.path ?? "/test" },
    module: { name: "TestModule" },
    controller: { instance: {}, method: "test", handler: () => {} },
    container: opts.container ?? new Container(),
  });
}

/** Fixed clock for tests. */
export function fixedClock(at: number): { now(): number; advance(ms: number): void } {
  let t = at;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Deterministic id generator for tests. */
export function counterIds(prefix = "test"): { next(): string } {
  let n = 0;
  return { next: () => `${prefix}-${++n}` };
}

export interface FakeFetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * Scripted upstream double. Queue responses (or errors) per call; every call
 * is recorded for assertions.
 */
export function fakeFetch(): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: FakeFetchCall[];
  respondWith(responses: Array<Response | Error>): void;
} {
  const calls: FakeFetchCall[] = [];
  const queue: Array<Response | Error> = [];
  return {
    calls,
    respondWith(responses: Array<Response | Error>): void {
      queue.push(...responses);
    },
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      calls.push({ url, init });
      const next = queue.shift();
      if (next === undefined) return new Response("no scripted response", { status: 500 });
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
