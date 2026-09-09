/**
 * `@minostack/mino/static` — static-file serving handler with loader injection.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Response` only; the `loader`
 * owns filesystem access so core never touches `node:*`).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { serveStatic } from "@minostack/mino/static";
 *
 * const app = new Mino();
 * app.use(serveStatic({ loader, prefix: "/static" }));
 * ```
 *
 * Behavior: strips `prefix`, blocks `..` traversal (`403`, never served
 * outside the loader root), applies `dotfiles` policy, maps extensions to
 * `content-type`, sets `content-length` / `last-modified` / `cache-control`
 * / `etag` (FNV-1a `"<len>-<hash>"`, weak) / `accept-ranges: bytes`,
 * answers `304` on matching `If-None-Match` / `If-Modified-Since`,
 * answers single-byte `Range` requests with `206` (`Content-Range` /
 * `Content-Length`, preserved `ETag`/`Last-Modified`/`Cache-Control`),
 * answers 2..8 ranges with `206 multipart/byteranges` (per-part
 * `Content-Type` + `Content-Range`; `>8` ranges → `200` full, documented),
 * answers unsatisfiable ranges with `416` (`Content-Range: bytes *\/size`,
 * empty body), ignores invalid ranges with a `200` full body (legal per
 * RFC 9110), honors `If-Range` (ETag weak comparison, `*` never matches,
 * else HTTP-date `<= mtime`; stale/missing validators → `200` full, never
 * multipart), evaluates `If-None-Match` / `If-Modified-Since` FIRST
 * (a `304` always wins over any `Range`/`If-Range`), and returns JSON
 * `404` when the loader has no entry.
 */

import type { Handler } from "./types.js";
import { generateETag } from "./etag.js";
import { contentTypeForExt, formatContentRange, parseRangeList } from "./file.js";

export interface StaticEntry {
  body: BodyInit | Uint8Array;
  type?: string;
  mtime?: Date;
  /** FULL representation size in bytes (not the range length). */
  size?: number;
}

export interface StaticLoader {
  load(path: string, range?: { start: number; end: number }): Promise<StaticEntry | undefined>;
}

export interface ServeStaticOptions {
  loader: StaticLoader;
  /** URL prefix to strip (default `/static`). */
  prefix?: string;
  /** `Cache-Control: public, max-age=N` seconds (default 3600). */
  maxAgeSec?: number;
  /** Serve `index.html` for trailing-slash paths (default false). */
  index?: boolean;
  /** Dotfile policy: `deny` → 403, `ignore` → 404, `allow` → serve (default `deny`). */
  dotfiles?: "deny" | "allow" | "ignore";
}

function jsonError(message: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: message, status, code }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Normalize a decoded sub-path, resolving `.` and refusing `..` escapes.
 * Returns `null` on traversal above the loader root.
 */
export function normalizeStaticPath(sub: string): string | null {
  const parts = sub.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join("/")}`;
}

function toBytes(body: StaticEntry["body"]): Uint8Array | null {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  return null;
}

function generateBoundary(): string {
  try {
    const c = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
    if (c.crypto && typeof c.crypto.randomUUID === "function") {
      return c.crypto.randomUUID().replace(/-/g, "");
    }
  } catch {
    // fall through to Math.random fallback (non-secure contexts)
  }
  const hex = (): string =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  return `${hex()}${hex()}${hex()}`;
}

/**
 * Validate `If-Range` against the current validators.
 *
 * - ETag weak comparison first (`W/` stripped on both sides; `*` never
 *   matches here) → fresh on equality.
 * - Else, when `mtime` is known, an HTTP-date `<= mtime` → fresh.
 * - Otherwise (garbage, future date, no mtime and no ETag match) → stale.
 *
 * Stale means the caller must ignore `Range` and serve `200` full
 * (never multipart). No `mtime` and no ETag match capability → stale.
 */
function isIfRangeFresh(ifRange: string, etagVal: string | null, mtime: Date | undefined): boolean {
  const token = ifRange.trim();
  if (token.length === 0 || token === "*") return false;
  if (etagVal) {
    const want = etagVal.replace(/^W\//, "").trim();
    const got = token.replace(/^W\//, "").trim();
    if (got.length > 0 && got === want) return true;
  }
  if (mtime) {
    const t = Date.parse(token);
    const lm = mtime.getTime();
    if (Number.isFinite(t) && Number.isFinite(lm) && t <= lm) return true;
  }
  return false;
}

export function serveStatic(opts: ServeStaticOptions): Handler {
  const { loader } = opts;
  const prefix = opts.prefix ?? "/static";
  const maxAgeSec = opts.maxAgeSec ?? 3600;
  const useIndex = opts.index ?? false;
  const dotfiles = opts.dotfiles ?? "deny";

  return async (c, next) => {
    if (c.method !== "GET" && c.method !== "HEAD") {
      await next();
      return;
    }
    let pathname: string;
    try {
      pathname = c.path;
    } catch {
      const out = jsonError("Bad Request", 400, "bad_request");
      c.setResponse(out);
      return out;
    }
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      await next();
      return;
    }

    const sub = pathname.slice(prefix.length) || "/";
    let decoded: string;
    try {
      decoded = decodeURIComponent(sub);
    } catch {
      const out = jsonError("Bad Request", 400, "bad_request");
      c.setResponse(out);
      return out;
    }
    // Backslash escapes are a traversal vector on some loaders — reject.
    if (decoded.includes("\\")) {
      const out = jsonError("Forbidden", 403, "forbidden");
      c.setResponse(out);
      return out;
    }

    let normalized = normalizeStaticPath(decoded);
    if (normalized === null) {
      const out = jsonError("Forbidden", 403, "forbidden");
      c.setResponse(out);
      return out;
    }
    if (normalized.endsWith("/") && normalized !== "/") {
      normalized = normalized.slice(0, -1);
    }
    // Directory request: optional index, otherwise 404.
    if (normalized === "/" || decoded.endsWith("/")) {
      if (useIndex) {
        normalized = normalized === "/" ? "/index.html" : `${normalized}/index.html`;
      } else if (normalized === "/") {
        const out = jsonError("Not Found", 404, "not_found");
        c.setResponse(out);
        return out;
      }
    }

    const segments = normalized.split("/").filter((s) => s.length > 0);
    if (dotfiles !== "allow" && segments.some((s) => s.startsWith("."))) {
      const out =
        dotfiles === "deny"
          ? jsonError("Forbidden", 403, "forbidden")
          : jsonError("Not Found", 404, "not_found");
      c.setResponse(out);
      return out;
    }

    const loaderPath = segments.join("/");
    let entry: StaticEntry | undefined;
    try {
      entry = await loader.load(loaderPath);
    } catch {
      const out = jsonError("Not Found", 404, "not_found");
      c.setResponse(out);
      return out;
    }
    if (!entry) {
      const out = jsonError("Not Found", 404, "not_found");
      c.setResponse(out);
      return out;
    }

    const h = new Headers();
    h.set("content-type", entry.type ?? contentTypeForExt(normalized));
    const bytes = toBytes(entry.body);
    const size = entry.size ?? bytes?.byteLength;
    if (size !== undefined) h.set("content-length", String(size));
    if (entry.mtime) h.set("last-modified", entry.mtime.toUTCString());
    h.set("cache-control", `public, max-age=${maxAgeSec}`);
    h.set("accept-ranges", "bytes");
    if (bytes) {
      h.set("etag", `W/${generateETag(bytes)}`);
    }

    // Conditional requests → 304 with stripped body.
    const inm = c.header("if-none-match");
    const ims = c.header("if-modified-since");
    const etagVal = h.get("etag");
    let preconditionHit = false;
    if (inm && etagVal) {
      const want = etagVal.replace(/^W\//, "").trim();
      for (const part of inm.split(",")) {
        const token = part.trim().replace(/^W\//, "").trim();
        if (token === "*" || (token && token === want)) {
          preconditionHit = true;
          break;
        }
      }
    }
    if (!preconditionHit && ims && entry.mtime) {
      const imsTime = Date.parse(ims);
      const lmTime = entry.mtime.getTime();
      if (Number.isFinite(imsTime) && Number.isFinite(lmTime) && imsTime >= lmTime) {
        preconditionHit = true;
      }
    }
    if (preconditionHit) {
      const h304 = new Headers();
      if (etagVal) h304.set("etag", etagVal);
      const lm = h.get("last-modified");
      if (lm) h304.set("last-modified", lm);
      h304.set("cache-control", `public, max-age=${maxAgeSec}`);
      h304.set("accept-ranges", "bytes");
      const out = new Response(null, { status: 304, headers: h304 });
      c.setResponse(out);
      return out;
    }

    // Precedence: `If-None-Match` / `If-Modified-Since` already won above
    // (304). `If-Range` is evaluated next — only when BOTH `Range` and
    // `If-Range` are present. Stale `If-Range` → ignore Range → 200 full
    // (never multipart, never 416).
    const rangeHeader = c.header("range");
    if (rangeHeader !== undefined && size !== undefined) {
      const ifRange = c.header("if-range");
      const rangeFresh =
        ifRange === undefined ? true : isIfRangeFresh(ifRange, etagVal, entry.mtime);
      if (rangeFresh) {
        const parsed = parseRangeList(rangeHeader, size);
        if (parsed === "unsatisfiable") {
          const h416 = new Headers();
          h416.set("content-range", `bytes */${size}`);
          h416.set("accept-ranges", "bytes");
          if (etagVal) h416.set("etag", etagVal);
          const lm = h.get("last-modified");
          if (lm) h416.set("last-modified", lm);
          h416.set("cache-control", `public, max-age=${maxAgeSec}`);
          const out = new Response(null, { status: 416, headers: h416 });
          c.setResponse(out);
          return out;
        }
        if (Array.isArray(parsed) && parsed.length === 1) {
          const single = parsed[0] as { start: number; end: number };
          const end = Math.min(single.end, size - 1);
          const start = single.start;
          let ranged: StaticEntry | undefined;
          try {
            ranged = await loader.load(loaderPath, { start, end });
          } catch {
            const out = jsonError("Not Found", 404, "not_found");
            c.setResponse(out);
            return out;
          }
          const source = ranged ?? entry;
          const rangeLen = end - start + 1;
          let rangedBytes = toBytes(source.body);
          let outBody: BodyInit | null;
          if (c.method === "HEAD") {
            outBody = null;
          } else if (rangedBytes) {
            // Loaders that ignore `range` return the full body — slice locally.
            // Loaders that honor it return exactly `rangeLen` bytes (trusted).
            if (rangedBytes.byteLength > rangeLen) {
              rangedBytes = rangedBytes.slice(start, end + 1);
            }
            outBody = rangedBytes as unknown as BodyInit;
          } else {
            outBody = source.body as unknown as BodyInit;
          }
          const h206 = new Headers();
          h206.set("content-type", source.type ?? entry.type ?? contentTypeForExt(normalized));
          h206.set("content-range", formatContentRange(start, end, size));
          h206.set("content-length", String(rangeLen));
          h206.set("accept-ranges", "bytes");
          if (etagVal) h206.set("etag", etagVal);
          const lm = h.get("last-modified");
          if (lm) h206.set("last-modified", lm);
          h206.set("cache-control", `public, max-age=${maxAgeSec}`);
          const out = new Response(outBody, { status: 206, headers: h206 });
          c.setResponse(out);
          return out;
        }
        if (Array.isArray(parsed) && parsed.length >= 2) {
          const boundary = generateBoundary();
          const fallbackType = entry.type ?? contentTypeForExt(normalized);
          const enc = new TextEncoder();
          const chunks: Uint8Array[] = [];
          let total = 0;
          const push = (u: Uint8Array): void => {
            chunks.push(u);
            total += u.byteLength;
          };
          const fullBytes = bytes;
          let failed = false;
          for (const r of parsed) {
            const s = r.start;
            const e = Math.min(r.end, size - 1);
            const len = e - s + 1;
            let partBytes: Uint8Array | null = null;
            let partType = fallbackType;
            if (fullBytes) {
              partBytes = fullBytes.slice(s, e + 1);
            } else {
              let partEntry: StaticEntry | undefined;
              try {
                partEntry = await loader.load(loaderPath, { start: s, end: e });
              } catch {
                const out = jsonError("Not Found", 404, "not_found");
                c.setResponse(out);
                return out;
              }
              const src = partEntry ?? entry;
              partType = src.type ?? fallbackType;
              const b = toBytes(src.body);
              if (b) {
                partBytes = b.byteLength > len ? b.slice(s, e + 1) : b;
              } else {
                try {
                  const buf = await new Response(src.body as unknown as BodyInit).arrayBuffer();
                  let arr = new Uint8Array(buf);
                  if (arr.byteLength > len) arr = arr.slice(s, e + 1);
                  partBytes = arr;
                } catch {
                  failed = true;
                  break;
                }
              }
            }
            push(
              enc.encode(
                `--${boundary}\r\nContent-Type: ${partType}\r\nContent-Range: ${formatContentRange(s, e, size)}\r\n\r\n`,
              ),
            );
            if (partBytes) push(partBytes);
            push(enc.encode("\r\n"));
          }
          if (!failed) {
            push(enc.encode(`--${boundary}--`));
            const flat = new Uint8Array(total);
            let off = 0;
            for (const ch of chunks) {
              flat.set(ch, off);
              off += ch.byteLength;
            }
            const h206 = new Headers();
            h206.set("content-type", `multipart/byteranges; boundary=${boundary}`);
            h206.set("content-length", String(total));
            h206.set("accept-ranges", "bytes");
            if (etagVal) h206.set("etag", etagVal);
            const lm = h.get("last-modified");
            if (lm) h206.set("last-modified", lm);
            h206.set("cache-control", `public, max-age=${maxAgeSec}`);
            const outBody: BodyInit | null =
              c.method === "HEAD" ? null : (flat as unknown as BodyInit);
            const out = new Response(outBody, { status: 206, headers: h206 });
            c.setResponse(out);
            return out;
          }
          // Stream buffering failed → fall through to 200 full.
        }
        // "invalid" / "too-many" (and unknown-size, guarded by `size !==
        // undefined` above): legal to ignore → fall through to 200 full.
      }
    }

    const body: BodyInit | null =
      c.method === "HEAD" ? null : ((bytes ?? entry.body) as unknown as BodyInit);
    const out = new Response(body, { status: 200, headers: h });
    c.setResponse(out);
    return out;
  };
}
