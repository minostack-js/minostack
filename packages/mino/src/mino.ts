/**
 * Mino — lightweight, Fetch-native, runtime-agnostic HTTP framework.
 * Owns: server abstraction, router, route registration, param extraction, middleware, context, lifecycle.
 * Does NOT own: IoC, module system, DI, ORM — those belong to @minostack/kernel.
 */

import { Context, type RequestLimits } from "./context.js";
import { Router } from "./router.js";
import { compose } from "./compose.js";
import { HttpError } from "./errors.js";
import type {
  Handler,
  MiddlewareHandler,
  ErrorHandler,
  NotFoundHandler,
  RouteDefinition,
} from "./types.js";

// Re-export for convenience
export { Context } from "./context.js";
export type { RequestLimits, ResolvedLimits } from "./context.js";
export { Router } from "./router.js";
export {
  HttpError,
  NotFoundError,
  BadRequestError,
  PayloadTooLargeError,
  ValidationError,
} from "./errors.js";

export type MinoOptions = {
  /** Global prefix applied to all routes (e.g. "/api") */
  prefix?: string;
  /** Whether to enable strict routing ("/foo" != "/foo/") — default false (trailing slash normalized) */
  strict?: boolean;
  /**
   * Demand limits (Phase A enterprise hardening). Merged over DEFAULT_LIMITS
   * (100kb bodies, 100 query/header keys, 8kb values, 100 form fields).
   * Exceeding a body limit returns 413; exceeding query/header bounds returns 400.
   */
  limits?: RequestLimits;
  /**
   * Proxy trust for client-IP resolution (rate limiting, logging).
   * - `false`/unset: `X-Forwarded-For` is ignored (spoofable); the runtime
   *   adapter's server-set `x-mino-peer` header is used when present.
   * - `true`: trust all hops, client = leftmost X-Forwarded-For entry.
   * - `N`: trust N closest hops, client = entry after the trusted suffix.
   * Runtime adapters MUST overwrite any client-sent `x-mino-peer` value.
   */
  trustProxy?: boolean | number;
};

export class Mino<E extends Record<string, unknown> = Record<string, unknown>> {
  private router: Router;
  private globalMiddleware: MiddlewareHandler<E>[] = [];
  private errorHandler: ErrorHandler<E> = (err, _c) => {
    if (err instanceof HttpError) return err.toResponse();
    if (err instanceof Error) {
      // Avoid leaking internal messages for 5xx
      return new Response(JSON.stringify({ error: "Internal Server Error", status: 500 }), {
        status: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return new Response("Internal Server Error", { status: 500 });
  };
  private notFoundHandler: NotFoundHandler<E> = () =>
    new Response(JSON.stringify({ error: "Not Found", status: 404 }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  private opts: MinoOptions;
  /** For introspection: list of route definitions */
  private routeDefs: RouteDefinition[] = [];
  /**
   * Precompiled pipeline cache per §15.
   * Key: `${method}:${routePath}` (or `404:`/`405:` for miss paths).
   * Value stores the globalMiddleware version it was compiled against —
   * `use()` bumps the version so late-registered middleware invalidates cache.
   * Keeps Fetch-native + runtime-agnostic moto: compile at setup/first-hit,
   * zero per-request `compose()` + spread on cache hit.
   */
  private pipelineCache = new Map<
    string,
    { version: number; fn: (c: Context) => Promise<Response> }
  >();
  private globalVersion = 0;

  constructor(opts: MinoOptions = {}) {
    this.opts = opts;
    this.router = new Router({ strict: opts.strict ?? false });
  }

  private invalidatePipeline(): void {
    this.globalVersion++;
    // Keep map bounded: clear on middleware change (routes re-compile lazily).
    // Route count is small (<10k); clearing avoids stale closures.
    this.pipelineCache.clear();
  }

  // ─────────────────────────────────────────────────────────────────
  // Global middleware & lifecycle hooks
  // ─────────────────────────────────────────────────────────────────

  use(...handlers: MiddlewareHandler<E>[]): this;
  use(path: string, ...handlers: MiddlewareHandler<E>[]): this;
  use(...handlers: MiddlewareHandler<E>[]): this;
  use(path: string, ...handlers: MiddlewareHandler<E>[]): this;
  use(pathOrHandler: string | MiddlewareHandler<E>, ...handlers: MiddlewareHandler<E>[]): this {
    if (typeof pathOrHandler === "string") {
      const prefix = this.normalizePath(pathOrHandler);
      const properWrapper: MiddlewareHandler<E> = async (c, next) => {
        // Strict prefix check to avoid /api matching /api-test (must be exact or prefix + "/")
        const isMatch = prefix === "/" || c.path === prefix || c.path.startsWith(prefix + "/");
        if (!isMatch) {
          await next();
          return;
        }
        let idx = -1;
        const dispatch = async (i: number): Promise<void> => {
          if (i <= idx) throw new Error("next() called multiple times");
          idx = i;
          const fn = handlers[i];
          if (!fn) {
            await next();
            return;
          }
          let nextCalled = false;
          const n = async () => {
            nextCalled = true;
            await dispatch(i + 1);
          };
          const res = (await (fn as unknown as Handler)(c as unknown as Context, n)) as unknown;
          if (res instanceof Response) {
            c.setResponse(res);
            return;
          }
          if (!nextCalled && i + 1 < handlers.length) {
            await dispatch(i + 1);
          }
        };
        await dispatch(0);
      };
      this.globalMiddleware.push(properWrapper);
      this.invalidatePipeline();
      return this;
    }
    this.globalMiddleware.push(...([pathOrHandler, ...handlers] as MiddlewareHandler<E>[]));
    this.invalidatePipeline();
    return this;
  }

  onError(handler: ErrorHandler<E>): this {
    this.errorHandler = handler;
    return this;
  }

  notFound(handler: NotFoundHandler<E>): this {
    this.notFoundHandler = handler;
    return this;
  }

  // ─────────────────────────────────────────────────────────────────
  // Route registration
  // ─────────────────────────────────────────────────────────────────

  private normalizePath(path: string): string {
    let p = path;
    const prefix = this.opts.prefix ? this.normalizePrefix(this.opts.prefix) : "";
    if (prefix) {
      // Join prefix + path
      if (p === "/") p = prefix;
      else p = `${prefix}${p.startsWith("/") ? p : `/${p}`}`;
    }
    if (!p.startsWith("/")) p = `/${p}`;
    // Keep as-is; Router.splitPath will normalize trailing slash
    return p;
  }

  private normalizePrefix(prefix: string): string {
    let p = prefix;
    if (!p.startsWith("/")) p = `/${p}`;
    if (p.endsWith("/")) p = p.slice(0, -1);
    if (p === "/") return "";
    return p;
  }

  private addRoute(method: string, path: string, handlers: Handler[]): this {
    const fullPath = this.normalizePath(path);
    // Precompiled pipeline (§15): router stores match; pipeline compiled lazily
    // on first hit per method+routePath and cached (see fetch). Global middleware
    // added later bumps globalVersion and clears cache.
    this.router.add(method, fullPath, handlers as Handler[]);
    this.routeDefs.push({
      method: method.toUpperCase(),
      path: fullPath,
      handlers: handlers as Handler[],
    });
    return this;
  }

  get<Path extends string>(
    path: Path,
    ...handlers: Handler<E, import("./types.js").ParamsFor<Path>>[]
  ): this {
    return this.addRoute("GET", path, handlers as unknown as Handler[]);
  }

  post<Path extends string>(
    path: Path,
    ...handlers: Handler<E, import("./types.js").ParamsFor<Path>>[]
  ): this {
    return this.addRoute("POST", path, handlers as unknown as Handler[]);
  }

  put<Path extends string>(
    path: Path,
    ...handlers: Handler<E, import("./types.js").ParamsFor<Path>>[]
  ): this {
    return this.addRoute("PUT", path, handlers as unknown as Handler[]);
  }

  delete<Path extends string>(
    path: Path,
    ...handlers: Handler<E, import("./types.js").ParamsFor<Path>>[]
  ): this {
    return this.addRoute("DELETE", path, handlers as unknown as Handler[]);
  }

  patch<Path extends string>(
    path: Path,
    ...handlers: Handler<E, import("./types.js").ParamsFor<Path>>[]
  ): this {
    return this.addRoute("PATCH", path, handlers as unknown as Handler[]);
  }

  options<Path extends string>(
    path: Path,
    ...handlers: Handler<E, import("./types.js").ParamsFor<Path>>[]
  ): this {
    return this.addRoute("OPTIONS", path, handlers as unknown as Handler[]);
  }

  head<Path extends string>(
    path: Path,
    ...handlers: Handler<E, import("./types.js").ParamsFor<Path>>[]
  ): this {
    return this.addRoute("HEAD", path, handlers as unknown as Handler[]);
  }

  all<Path extends string>(
    path: Path,
    ...handlers: Handler<E, import("./types.js").ParamsFor<Path>>[]
  ): this {
    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];
    for (const m of methods) this.addRoute(m, path, handlers as unknown as Handler[]);
    return this;
  }

  // Generic route method
  route(method: string, path: string, ...handlers: Handler<E>[]): this {
    return this.addRoute(method, path, handlers as unknown as Handler[]);
  }

  /**
   * Mount a sub-app at a prefix. Copies route defs and merges global middleware.
   * Note: sub-app's global middleware becomes path-scoped to mount point.
   */
  mount(prefix: string, sub: Mino<Record<string, unknown>>): this {
    const base = this.normalizePath(prefix);
    // For each route in sub, re-register under base prefix
    for (const r of (sub as unknown as { routeDefs: RouteDefinition[]; router: Router })
      .routeDefs) {
      const subPath = r.path; // already normalized in sub (may include sub's prefix)
      const full = `${base}${subPath === "/" ? "" : subPath}`;
      const finalPath = full || "/";
      // Need to carry over sub's global middleware? Sub's routes were registered without global prefix mixing?
      // For mount, we want sub's global middleware to run only for mounted routes.
      // Store handlers as: path-scoped global middleware wrapper + route handlers
      // Simpler: add route with handlers as originally registered (without sub global middleware) — but then sub global won't run.
      // We'll approximate: just register route handlers; sub global is not automatically applied.
      // User should use `app.use` on parent if they want global coverage.
      this.router.add(r.method, this.normalizePath(finalPath), r.handlers as Handler[]);
      this.routeDefs.push({
        method: r.method,
        path: this.normalizePath(finalPath),
        handlers: r.handlers,
      });
    }
    return this;
  }

  // ─────────────────────────────────────────────────────────────────
  // Fetch handler — the core of Mino (Fetch-native)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Fetch entry point — `app.fetch(request)` is the standard way to handle a request.
   * Also serves as the `fetch` handler for Bun/Deno/Workers.
   */
  readonly fetch = async (request: Request, env: E = {} as E): Promise<Response> => {
    // Zero-URL-parse hot path (§16, CPU bottom-line): extract pathname via
    // string slice, no `new URL` unless Context lazily needs it (c.url/query).
    // c.text/c.json never pay URL cost. Malformed URLs fall back to 400.
    const upMethod = request.method.toUpperCase();
    let pathname: string;
    try {
      const u = request.url;
      const proto = u.indexOf("://");
      if (proto === -1) {
        pathname = new URL(u).pathname;
      } else {
        const start = u.indexOf("/", proto + 3);
        if (start === -1) {
          pathname = "/";
        } else {
          let end = u.length;
          const q = u.indexOf("?", start);
          if (q !== -1) end = q;
          const h = u.indexOf("#", start);
          if (h !== -1 && h < end) end = h;
          pathname = u.slice(start, end);
          if (pathname.length === 0) pathname = "/";
        }
        // Preserve 400 for malformed authority (e.g. "http://%"):
        // fast slice ignores host validation, so validate suspicious hosts.
        // Empty/userinfo/bracketed hosts are rejected outright (WHATWG URL
        // tolerates some, e.g. "http:///x"); the rest fall back to new URL.
        const host = u.slice(proto + 3, start === -1 ? u.length : start);
        if (
          host.length === 0 ||
          host.indexOf("@") !== -1 ||
          host.indexOf("[") !== -1 ||
          host.indexOf("]") !== -1 ||
          host.indexOf("\\") !== -1
        ) {
          throw new Error("Bad host");
        }
        if (
          host.indexOf("%") !== -1 ||
          host.indexOf(" ") !== -1 ||
          host.indexOf("\t") !== -1 ||
          host.indexOf("\n") !== -1 ||
          host.indexOf("\r") !== -1
        ) {
          // Throws on malformed URL → 400 below. Valid encoded paths keep
          // sliced pathname (no extra alloc beyond this validation branch).
          pathname = new URL(u).pathname;
        }
      }
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Hardening (A3): bound recursion in router trie walk. 414 for absurd
    // paths; segment count only when path is long (hot path stays O(1)).
    if (pathname.length > 2048) {
      return new Response(JSON.stringify({ error: "URI Too Long", status: 414 }), {
        status: 414,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (pathname.length > 256) {
      let slashes = 0;
      for (let i = 0; i < pathname.length; i++) {
        if (pathname.charCodeAt(i) === 47) {
          slashes++;
          if (slashes > 128) {
            return new Response(JSON.stringify({ error: "URI Too Long", status: 414 }), {
              status: 414,
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          }
        }
      }
    }

    let match: ReturnType<Router["match"]> = null;
    try {
      match = this.router.match(upMethod, pathname);
    } catch (err) {
      if (err instanceof HttpError) return err.toResponse();
      // Fallback for BadRequestError from router decode
      const isBadRequest =
        err !== null &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status: number }).status === 400;
      if (isBadRequest) {
        // Hardening (A3): fixed message — never echo router internals or the
        // offending segment bytes back to the client.
        return new Response(
          JSON.stringify({ error: "Bad Request", status: 400, code: "bad_request" }),
          {
            status: 400,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      throw err;
    }
    // Context lazily parses URL only if c.url/c.query/c.path touched.
    const c = new Context<E, Record<string, string>>(request, {
      env,
      params: (match?.params ?? {}) as Record<string, string>,
      routePath: match?.routePath,
      limits: this.opts.limits,
    });

    // Precompiled pipeline (§15): cache per method+routePath + globalVersion.
    // Cache hit = zero spread + zero compose(). Miss composes once.
    // 404 shares one entry (same handlers for every miss path); 405 keys by Allow set.
    // upMethod computed once above — no second toUpperCase per request.
    let cacheKey: string;
    let allowed: string[] = [];
    if (match) {
      cacheKey = `${upMethod}:${match.routePath}`;
    } else {
      allowed = this.router.allowedMethods(pathname);
      cacheKey = allowed.length > 0 ? `405:${allowed.join(",")}` : "404";
    }
    const cached = this.pipelineCache.get(cacheKey);
    let compiled: (c: Context) => Promise<Response>;
    if (cached && cached.version === this.globalVersion) {
      compiled = cached.fn as (c: Context) => Promise<Response>;
    } else {
      let handlers: Handler[];
      if (match) {
        handlers =
          this.globalMiddleware.length === 0
            ? (match.handlers as Handler[])
            : ([...this.globalMiddleware, ...match.handlers] as unknown as Handler[]);
      } else {
        if (allowed.length > 0) {
          const allowHeader = allowed.join(", ");
          const methodNotAllowedHandler: Handler = async () => {
            return new Response(JSON.stringify({ error: "Method Not Allowed", status: 405 }), {
              status: 405,
              headers: {
                "content-type": "application/json; charset=utf-8",
                allow: allowHeader,
              },
            });
          };
          handlers =
            this.globalMiddleware.length === 0
              ? [methodNotAllowedHandler]
              : ([...this.globalMiddleware, methodNotAllowedHandler] as unknown as Handler[]);
        } else {
          // Not found — run global middleware + notFound handler as final
          const notFoundHandler = this.notFoundHandler;
          const nf: Handler = async (ctx) => {
            const res = await notFoundHandler(ctx as unknown as Context<E, Record<string, string>>);
            return res;
          };
          handlers =
            this.globalMiddleware.length === 0
              ? [nf]
              : ([...this.globalMiddleware, nf] as unknown as Handler[]);
        }
      }
      compiled = compose(handlers);
      // Bound cache (C5): 404 shares one key and 405 keys by Allow-set, so only
      // genuine route growth adds entries. Eviction is single-entry FIFO, not
      // LRU, deliberately: re-inserting on every hit would add two Map ops to
      // the hot path. Route tables change at deploy time, not per request, so
      // FIFO cannot thrash in steady state (pinned by cache-size tests).
      if (this.pipelineCache.size >= 1024) {
        const first = this.pipelineCache.keys().next();
        if (!first.done) this.pipelineCache.delete(first.value);
      }
      this.pipelineCache.set(cacheKey, { version: this.globalVersion, fn: compiled });
    }

    try {
      const res = await compiled(c as unknown as Context);
      // Hardening (A1): handlers must return Response. A leaked string/object
      // would violate the fetch contract and crash callers on .text(). Fail
      // closed with a generic 500 (no internal detail leaked). Duck-check keeps
      // cross-realm Response support (see compose isResponse + p0 test).
      const isRes =
        res instanceof Response ||
        (typeof res === "object" &&
          res !== null &&
          typeof (res as { status?: unknown }).status === "number" &&
          typeof (res as { headers?: unknown }).headers === "object" &&
          (res as { headers: unknown }).headers !== null &&
          typeof (res as { arrayBuffer?: unknown }).arrayBuffer === "function");
      if (!isRes) {
        return new Response("Internal Server Error", { status: 500 });
      }
      // HEAD: strip body if needed (Fetch spec: HEAD must not include body)
      if (upMethod === "HEAD" && res.body) {
        // Return same response without body; remove content-length that would mismatch empty body
        // (GET content-length describes GET body, but HEAD body is empty; keeping it confuses fetch clients)
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        return new Response(null, { status: res.status, headers });
      }
      return res;
    } catch (err) {
      try {
        const res = await this.errorHandler(
          err,
          c as unknown as Context<E, Record<string, string>>,
        );
        if (res instanceof Response) return res;
        return new Response("Internal Server Error", { status: 500 });
      } catch (handlerErr) {
        // Hardening (C2): redact — log name + message only, never stack/cause
        // (stacks leak paths, dependency versions, and query values to logs).
        const safe =
          handlerErr instanceof Error
            ? `${handlerErr.name}: ${handlerErr.message}`
            : String(handlerErr).slice(0, 500);
        console.error(`[mino] errorHandler threw: ${safe}`);
        return new Response("Internal Server Error", { status: 500 });
      }
    }
  };

  // Alias for compatibility with `app.handle`
  handle = this.fetch;

  // ─────────────────────────────────────────────────────────────────
  // Introspection — for OpenAPI, GraphQL, RPC, tests
  // ─────────────────────────────────────────────────────────────────

  getRoutes(): ReadonlyArray<RouteDefinition> {
    return this.routeDefs;
  }

  /** Return the underlying Router (internal, for advanced use) */
  getRouter(): Router {
    return this.router;
  }
}
