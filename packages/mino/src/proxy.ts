/**
 * `@minostack/mino/proxy` — reverse-proxy terminal handler + prefix dispatcher.
 *
 * Zero dependencies, runtime-agnostic (global `fetch` + `AbortController` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { proxy, combine } from "@minostack/mino/proxy";
 *
 * const app = new Mino();
 * // Proxy everything under /api to the upstream origin (path + query preserved).
 * app.all("/api/*", proxy("http://127.0.0.1:9000"));
 *
 * // Or dispatch by prefix, preserving each sub-app's own middleware.
 * const gateway = combine([
 *   { prefix: "/api", app: apiApp },
 *   { prefix: "/", app: webApp },
 * ]);
 * ```
 *
 * Forwarding contract (`proxy`):
 * - `Authorization` — and every other non-hop-by-hop header — is forwarded by
 *   default. Stripping credentials is the caller's job via `opts.headers`.
 * - Hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`,
 *   `upgrade`, `trailer`, `te`, `proxy-*`, plus any header named in the
 *   incoming `Connection` list) are stripped in both directions.
 * - The request body (`c.req.body`) streams straight through when present;
 *   `GET`/`HEAD` never send a body.
 * - `x-forwarded-for` appends the peer (server-set `x-mino-peer` when present,
 *   else the existing value is kept); `x-forwarded-proto` / `x-forwarded-host`
 *   describe the incoming edge.
 * - Upstream failures and timeouts answer `502 {code:"bad_gateway"}` with a
 *   generic message — upstream details are never leaked to the client or logs.
 *
 * Middleware contract: `proxy()` is terminal — register it as the last handler
 * (`app.all(path, proxy(...))`). It never calls `next()`; it rebuilds the
 * upstream response and returns it.
 *
 * `combine()` preserves sub-app middleware (unlike `Mino.mount`, which copies
 * routes and drops the sub-app's global middleware) and strips NOTHING from
 * the path — sub-apps see the full original URL, so register sub-app routes at
 * their full paths.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";

export type ProxyTarget = string | ((req: Request) => string | Promise<string>);

export interface ProxyOptions {
  /**
   * Add/override outgoing headers (`HeadersInit`), or mutate the forwarded set
   * directly (delete credentials, rotate tokens, ...).
   */
  headers?: HeadersInit | ((outgoing: Headers, c: Context) => void);
  /** Mutate the resolved upstream URL before the fetch (prefix rewrite, ...). */
  rewrite?: (url: URL) => void;
  /** Upstream time-to-headers budget in ms (default: none). */
  timeoutMs?: number;
  /**
   * Upstream allowlist (enterprise hardening, plan P2.5). Entries are origin
   * prefixes (`"https://api.example.com"`); a function gets the final URL
   * (after `rewrite`) for dynamic policy. Disallowed targets answer generic
   * `502 {code:"bad_gateway"}` — never leak the target.
   */
  allowedTargets?: Array<string | RegExp> | ((url: URL) => boolean);
  /**
   * Fetch implementation (default: global `fetch`). Inject to compose
   * resilience policies (`withRetry`, `CircuitBreaker`) or fake upstream in
   * tests. Receives the upstream URL string plus init.
   */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface CombineRoute {
  /** Path prefix (default `"/"`). Leading `/` added, trailing `/` trimmed. */
  prefix?: string;
  /** Any Fetch-native app — typed structurally, no Mino import needed. */
  app: { fetch: (req: Request) => Promise<Response> };
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "trailer",
  "te",
]);

function isHopByHop(name: string): boolean {
  const lower = name.toLowerCase();
  return HOP_BY_HOP.has(lower) || lower.startsWith("proxy-");
}

/** Header names the client asked to treat as hop-by-hop (`Connection: ...`). */
function connectionListed(headers: Headers): Set<string> {
  const out = new Set<string>();
  headers.forEach((value, key) => {
    if (key !== "connection") return;
    for (const part of value.split(",")) {
      const token = part.trim().toLowerCase();
      if (token.length > 0) out.add(token);
    }
  });
  return out;
}

function jsonError(error: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error, status, code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Allowlist check against the final upstream URL. String entries match by
 * origin prefix; RegExp entries test the full URL. No allowlist = allow all
 * (backwards compatible); an empty array denies all.
 */
export function isTargetAllowed(
  url: URL,
  allowed?: Array<string | RegExp> | ((url: URL) => boolean),
): boolean {
  if (allowed === undefined) return true;
  if (typeof allowed === "function") return allowed(url);
  for (const entry of allowed) {
    if (typeof entry === "string") {
      if (url.origin === entry || url.href.startsWith(entry)) return true;
    } else if (entry.test(url.href)) {
      return true;
    }
  }
  return false;
}

/**
 * Terminal reverse-proxy handler. String targets are origin prefixes joined
 * with the incoming path + query; function targets resolve the full upstream
 * URL dynamically per request.
 */
export function proxy(target: ProxyTarget, opts: ProxyOptions = {}): Handler {
  return async (c) => {
    const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
    try {
      let upstream: string;
      if (typeof target === "function") {
        upstream = await target(c.req);
      } else {
        const incoming = new URL(c.req.url);
        const base = target.endsWith("/") ? target.slice(0, -1) : target;
        upstream = `${base}${incoming.pathname}${incoming.search}`;
      }
      const url = new URL(upstream);
      opts.rewrite?.(url);
      if (!isTargetAllowed(url, opts.allowedTargets)) {
        return jsonError("Bad Gateway", 502, "bad_gateway");
      }

      const listed = connectionListed(c.req.headers);
      const outgoing = new Headers();
      c.req.headers.forEach((value, key) => {
        if (isHopByHop(key) || listed.has(key)) return;
        outgoing.append(key, value);
      });

      const peer = c.req.headers.get("x-mino-peer");
      const existingXff = c.req.headers.get("x-forwarded-for");
      if (peer !== null && peer.length > 0) {
        outgoing.set("x-forwarded-for", existingXff ? `${existingXff}, ${peer}` : peer);
      } else if (existingXff !== null) {
        outgoing.set("x-forwarded-for", existingXff);
      }
      const incomingUrl = new URL(c.req.url);
      outgoing.set("x-forwarded-proto", incomingUrl.protocol.replace(/:$/, ""));
      outgoing.set("x-forwarded-host", c.req.headers.get("host") ?? incomingUrl.host);

      const headersOpt = opts.headers;
      if (typeof headersOpt === "function") {
        headersOpt(outgoing, c as Context);
      } else if (headersOpt instanceof Headers) {
        headersOpt.forEach((value, key) => outgoing.set(key, value));
      } else if (headersOpt !== undefined) {
        new Headers(headersOpt).forEach((value, key) => outgoing.set(key, value));
      }

      const ac = new AbortController();
      if (opts.timeoutMs !== undefined) {
        timer.id = setTimeout(() => ac.abort(), opts.timeoutMs);
        (timer.id as unknown as { unref?: () => void }).unref?.();
      }

      const method = c.req.method;
      const upper = method.toUpperCase();
      const body = upper === "GET" || upper === "HEAD" ? undefined : c.req.body;
      const init = {
        method,
        headers: outgoing,
        signal: ac.signal,
      } as RequestInit & { duplex?: string; body?: BodyInit | null };
      if (body !== undefined && body !== null) {
        init.body = body;
        init.duplex = "half";
      }

      const upstreamRes = await (opts.fetchFn ?? fetch)(url.toString(), init);
      const resHeaders = new Headers();
      upstreamRes.headers.forEach((value, key) => {
        if (key === "set-cookie" || isHopByHop(key)) return;
        resHeaders.append(key, value);
      });
      for (const cookie of upstreamRes.headers.getSetCookie()) {
        resHeaders.append("set-cookie", cookie);
      }
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: resHeaders,
      });
    } catch {
      return jsonError("Bad Gateway", 502, "bad_gateway");
    } finally {
      if (timer.id !== undefined) clearTimeout(timer.id);
    }
  };
}

function normalizePrefix(prefix: string): string {
  const leading = prefix.startsWith("/") ? prefix : `/${prefix}`;
  if (leading.length > 1 && leading.endsWith("/")) return leading.slice(0, -1);
  return leading;
}

function matchesPrefix(prefix: string, pathname: string): boolean {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Prefix dispatcher over structurally-typed Fetch apps. Longest-prefix match
 * wins; ties go to the earliest route. No match answers
 * `404 {code:"not_found"}`.
 */
export function combine(routes: Array<CombineRoute>): (req: Request) => Promise<Response> {
  const normalized = routes.map((r) => ({ prefix: normalizePrefix(r.prefix ?? "/"), app: r.app }));
  return (req: Request): Promise<Response> => {
    const pathname = new URL(req.url).pathname;
    let best: { prefix: string; app: { fetch: (req: Request) => Promise<Response> } } | undefined;
    for (const r of normalized) {
      if (!matchesPrefix(r.prefix, pathname)) continue;
      if (best === undefined || r.prefix.length > best.prefix.length) best = r;
    }
    if (best === undefined) return Promise.resolve(jsonError("Not Found", 404, "not_found"));
    return best.app.fetch(req);
  };
}
