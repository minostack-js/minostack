/**
 * `@minostack/mino/method-override` — HTML-form method override (`POST` → `PUT`/`PATCH`/`DELETE`).
 *
 * Zero dependencies, runtime-agnostic (Fetch `Request` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { withMethodOverride } from "@minostack/mino/method-override";
 *
 * const app = new Mino();
 * app.put("/items/:id", (c) => c.text("updated"));
 *
 * // Browsers only submit GET/POST — tunnel the rest through POST:
 * // <form method="POST" action="/items/1?_method=PUT">
 * export default { fetch: withMethodOverride(app) };
 * ```
 *
 * FETCH-LEVEL wrapper, not middleware — and deliberately so: Mino matches the
 * route before middleware runs, and `c.method` reads the immutable Fetch
 * `Request`. A post-match middleware therefore cannot affect routing; the
 * override must rebuild the `Request` before `app.fetch` sees it.
 *
 * Only `methods` (default `["POST"]`) are override candidates. The override
 * source is the `header` (default `"x-http-method-override"`, wins) then the
 * `?_method` query param (`query` renames it, `false` disables it). Values
 * outside `allowed` (default `["PUT","PATCH","DELETE"]`) are IGNORED — the
 * request proceeds as its original method, never a 4xx (a forged
 * `_method=BREW` must not break plain form posts).
 */

export interface MethodOverrideOptions {
  /** Header carrying the override (default `"x-http-method-override"`). */
  header?: string;
  /** Query param carrying the override (default `"_method"`, `false` disables). */
  query?: string | false;
  /** Incoming methods eligible for override (default `["POST"]`). */
  methods?: string[];
  /** Override targets honored (default `["PUT","PATCH","DELETE"]`). */
  allowed?: string[];
}

/**
 * Structural app shape — Mino instances satisfy it without importing Mino
 * (avoids a dependency cycle; note `Mino#fetch` takes an optional second
 * `env` arg, which is assignable to this single-param shape).
 */
export interface FetchApp {
  fetch: (req: Request) => Promise<Response>;
}

export function withMethodOverride(
  app: FetchApp,
  opts: MethodOverrideOptions = {},
): (req: Request) => Promise<Response> {
  const headerName = opts.header ?? "x-http-method-override";
  const queryName = opts.query ?? "_method";
  const triggers = new Set((opts.methods ?? ["POST"]).map((m) => m.toUpperCase()));
  const allow = new Set((opts.allowed ?? ["PUT", "PATCH", "DELETE"]).map((m) => m.toUpperCase()));

  return (req: Request): Promise<Response> => {
    if (!triggers.has(req.method.toUpperCase())) return app.fetch(req);
    const fromHeader = req.headers.get(headerName)?.trim();
    let override = fromHeader ? fromHeader : undefined;
    if (!override && queryName !== false) {
      override = new URL(req.url).searchParams.get(queryName)?.trim() ?? undefined;
    }
    if (!override) return app.fetch(req);
    const up = override.toUpperCase();
    // Invalid override → ignore (proceed as the original method), never 4xx.
    if (!allow.has(up)) return app.fetch(req);
    // Rebuild is required: the Fetch Request method is immutable. Headers,
    // streaming body, and abort signal carry over; nothing else is touched.
    const init: RequestInit & { duplex?: "half" } = {
      method: up,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
      duplex: "half",
    };
    return app.fetch(new Request(req.url, init));
  };
}
