/**
 * `@minostack/mino/versioning` — canonical URL versioning (plan P4.1).
 *
 * Zero dependencies, runtime-agnostic. Versions live in the path
 * (`/v1/users`, `/v2/users`) — no header negotiation. Deprecated versions
 * advertise `Deprecation` + `Sunset` headers so clients can migrate.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { versioned, sunset } from "@minostack/mino/versioning";
 *
 * const app = new Mino();
 * const v1 = versioned(app, "v1");
 * v1.get("/users", sunset({ date: "2027-01-01", successor: "/v2/users" }), listV1);
 * const v2 = versioned(app, "v2");
 * v2.get("/users", listV2);
 * ```
 *
 * Routes register directly on `app` under the version prefix (no mount
 * timing pitfalls — `Mino.mount` copies routes eagerly, so a mounted sub-app
 * would miss routes registered after the mount call).
 */

import { Mino } from "./mino.js";
import type { Handler, MiddlewareHandler } from "./types.js";

/** Normalize `"v1"` / `"1"` / `1` to the `"/v1"` path prefix. */
export function versionPrefix(version: string | number): string {
  const v = String(version).replace(/^v/, "");
  return `/v${v}`;
}

export interface VersionedApp<E extends Record<string, unknown> = Record<string, unknown>> {
  readonly version: string;
  readonly prefix: string;
  get(path: string, ...handlers: Handler<E>[]): void;
  post(path: string, ...handlers: Handler<E>[]): void;
  put(path: string, ...handlers: Handler<E>[]): void;
  patch(path: string, ...handlers: Handler<E>[]): void;
  delete(path: string, ...handlers: Handler<E>[]): void;
  options(path: string, ...handlers: Handler<E>[]): void;
  head(path: string, ...handlers: Handler<E>[]): void;
  all(path: string, ...handlers: Handler<E>[]): void;
  route(method: string, path: string, ...handlers: Handler<E>[]): void;
  use(...handlers: MiddlewareHandler<E>[]): void;
  use(path: string, ...handlers: MiddlewareHandler<E>[]): void;
}

/**
 * Create a version scope on `app`. Every route/middleware registers under
 * `/vN`, versions coexist, and `app.getRoutes()` shows the full versioned
 * paths (so OpenAPI documents stay version-aware).
 */
export function versioned<E extends Record<string, unknown> = Record<string, unknown>>(
  app: Mino<E>,
  version: string | number,
): VersionedApp<E> {
  const prefix = versionPrefix(version);
  const at = (path: string): string =>
    path === "/" ? prefix : `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
  const scope: VersionedApp<E> = {
    version: prefix.slice(1),
    prefix,
    get: (path, ...handlers) => void app.get(at(path), ...handlers),
    post: (path, ...handlers) => void app.post(at(path), ...handlers),
    put: (path, ...handlers) => void app.put(at(path), ...handlers),
    patch: (path, ...handlers) => void app.patch(at(path), ...handlers),
    delete: (path, ...handlers) => void app.delete(at(path), ...handlers),
    options: (path, ...handlers) => void app.options(at(path), ...handlers),
    head: (path, ...handlers) => void app.head(at(path), ...handlers),
    all: (path, ...handlers) => void app.all(at(path), ...handlers),
    route: (method, path, ...handlers) => void app.route(method, at(path), ...handlers),
    use: (pathOrHandler: string | MiddlewareHandler<E>, ...handlers: MiddlewareHandler<E>[]) => {
      if (typeof pathOrHandler === "string") {
        void app.use(at(pathOrHandler), ...handlers);
      } else {
        void app.use(at("/"), pathOrHandler, ...handlers);
      }
    },
  };
  return scope;
}

export interface SunsetOptions {
  /** Sunset date, e.g. `"2027-01-01"` (emitted verbatim as the `Sunset` header). */
  date: string;
  /** Successor path, e.g. `"/v2/users"` (emitted as `Link: <>; rel="successor-version"`). */
  successor?: string;
  /** Also emit the draft `Deprecation: true` header (default true). */
  deprecation?: boolean;
}

/**
 * Deprecation middleware — marks a route/version as deprecated without
 * changing its behavior. Explicit route headers still win when the handler
 * already set `Sunset`/`Deprecation`.
 */
export function sunset(opts: SunsetOptions): Handler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (!res) return;
    const h = new Headers(res.headers);
    if (opts.deprecation !== false && !h.has("deprecation")) h.set("deprecation", "true");
    if (!h.has("sunset")) h.set("sunset", opts.date);
    if (opts.successor && !h.has("link")) {
      h.set("link", `<${opts.successor}>; rel="successor-version"`);
    }
    const out = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: h,
    });
    c.setResponse(out);
    return out;
  };
}
