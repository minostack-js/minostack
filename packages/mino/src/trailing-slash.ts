/**
 * `@minostack/mino/trailing-slash` — canonical trailing-slash redirects.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Response` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { trailingSlash } from "@minostack/mino/trailing-slash";
 *
 * const app = new Mino();
 * app.use(trailingSlash("always")); // /about → 308 /about/
 * app.use(trailingSlash("never")); // /about/ → 308 /about
 * ```
 *
 * `"always"` 308-redirects slashless paths to their slashed form (query
 * preserved); `"never"` does the reverse (query preserved). Root `/` is
 * canonical under both modes. Under `"always"`, paths whose last segment
 * looks like a file (`/app.js`, `/feed.xml`) are left alone — appending a
 * slash to a static asset is never what you want. Already-canonical paths
 * call downstream untouched.
 */

import type { Handler } from "./types.js";

export type TrailingSlashMode = "always" | "never";

/**
 * True when the last path segment contains a dot (`/app.js` is a file;
 * `/a.b/c` is not — only the segment after the final slash counts).
 */
function looksLikeFile(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".");
}

export function trailingSlash(mode: TrailingSlashMode): Handler {
  return async (c, next) => {
    // c.path / c.url trigger the lazy URL parse — acceptable: installing this
    // middleware opts in, and redirect decisions need the parsed path + query.
    const path = c.path;
    if (mode === "always") {
      if (path.endsWith("/") || looksLikeFile(path)) {
        await next();
        return;
      }
      return c.redirect(`${path}/${c.url.search}`, 308);
    }
    if (path.length <= 1 || !path.endsWith("/")) {
      await next();
      return;
    }
    return c.redirect(`${path.slice(0, -1)}${c.url.search}`, 308);
  };
}
