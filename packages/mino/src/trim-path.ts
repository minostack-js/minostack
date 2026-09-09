/**
 * `@minostack/mino/trim-path` — collapse duplicate slashes and `/./` segments.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Request`/`Response` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { trimPath } from "@minostack/mino/trim-path";
 *
 * const app = new Mino();
 * app.use(trimPath()); // //a///b → 308 /a/b, /a/./b → 308 /a/b
 * ```
 *
 * Non-canonical pathnames 308-redirect to their collapsed form (query
 * preserved); canonical paths call downstream untouched. Decode-safe: the
 * pathname is extracted via raw string slices (never `new URL`, never
 * decoded), so `/a/%2E%2E/b` stays byte-identical. Dot-dot collapsing is
 * intentionally out of scope.
 */

import type { Handler } from "./types.js";

/** Raw pathname via string slices only — never parsed, never decoded. */
function rawPathname(url: string): string {
  const afterScheme = url.indexOf("://") + 3;
  let start = url.indexOf("/", afterScheme);
  if (start === -1) start = url.length;
  let end = url.indexOf("?", afterScheme);
  if (end === -1) end = url.length;
  const hash = url.indexOf("#", afterScheme);
  if (hash !== -1 && hash < end) end = hash;
  const path = url.slice(start, end);
  return path.length === 0 ? "/" : path;
}

/** Collapse `//+` runs and `/./` segments (`/a/./` → `/a/`, trailing `/.` → `/`). */
function collapsePath(path: string): string {
  let out = path.replace(/\/{2,}/g, "/");
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(/\/\.\//g, "/");
    if (out.endsWith("/.")) out = out.slice(0, -1);
  }
  return out;
}

export function trimPath(): Handler {
  return async (c, next) => {
    // Raw slices (decode-safe) for the decision; c.url only for the query,
    // which stays percent-encoded and is appended verbatim.
    const path = rawPathname(c.req.url);
    const clean = collapsePath(path);
    if (clean === path) {
      await next();
      return;
    }
    return c.redirect(`${clean}${c.url.search}`, 308);
  };
}
