/**
 * `@minostack/mino/vhost` — Host-based virtual hosting dispatcher.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Request`/`Response` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { vhost } from "@minostack/mino/vhost";
 *
 * const api = new Mino();
 * api.get("/status", (c) => c.json({ ok: true }));
 * const web = new Mino();
 * web.get("/", (c) => c.html("<h1>hi</h1>"));
 *
 * export default { fetch: vhost({ "api.example.com": api, "*.example.com": web }) };
 * ```
 *
 * FETCH-LEVEL dispatcher, not middleware — and deliberately so: the target
 * app must be selected BEFORE routing (each app owns its own router), and
 * middleware runs post-match. `Host` is matched case-insensitively with any
 * `:port` stripped; exact names beat `*.example.com` wildcards, and among
 * wildcards the longest (most-specific) suffix wins. Unmatched hosts go to
 * `opts.default` when given, else `404` JSON (`{ error, status, code }`).
 * The original `Request` is forwarded untouched.
 */

/**
 * Structural app shape — Mino instances satisfy it without importing Mino
 * (avoids a dependency cycle).
 */
export interface VhostTarget {
  fetch: (req: Request) => Promise<Response>;
}

export interface VhostOptions {
  /** Fallback app for unmatched hosts (default: `404` JSON). */
  default?: VhostTarget;
}

/** Host for routing: `Host` header (else URL host), lowercased, `:port` stripped. */
function requestHost(req: Request): string {
  const raw = req.headers.get("host") ?? new URL(req.url).host;
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[")) {
    // IPv6 literal (`[::1]:3000`) — strip the port, keep the brackets.
    host = host.slice(0, host.indexOf("]") + 1);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  return host;
}

export function vhost(
  routes: Record<string, VhostTarget>,
  opts: VhostOptions = {},
): (req: Request) => Promise<Response> {
  const exact = new Map<string, VhostTarget>();
  const wildcards: Array<{ suffix: string; app: VhostTarget }> = [];
  for (const key of Object.keys(routes)) {
    // Split returns ≥1 element; the cast keeps noUncheckedIndexedAccess honest.
    const app = routes[key] as VhostTarget;
    if (key.startsWith("*.")) {
      // `*.example.com` matches subdomains only, never the bare domain.
      wildcards.push({ suffix: key.slice(1).toLowerCase(), app });
    } else {
      exact.set(key.toLowerCase(), app);
    }
  }
  // Longest suffix first → most-specific wildcard wins.
  wildcards.sort((a, b) => b.suffix.length - a.suffix.length);

  return (req: Request): Promise<Response> => {
    const host = requestHost(req);
    const hit = exact.get(host);
    if (hit) return hit.fetch(req);
    for (const w of wildcards) {
      if (host.length > w.suffix.length && host.endsWith(w.suffix)) {
        return w.app.fetch(req);
      }
    }
    if (opts.default) return opts.default.fetch(req);
    return Promise.resolve(
      new Response(JSON.stringify({ error: "Not Found", status: 404, code: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
  };
}
