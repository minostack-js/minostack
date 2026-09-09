/**
 * `@minostack/mino/file` — file-download helpers + HTTP Range parsing.
 *
 * Zero dependencies, runtime-agnostic, Fetch-only. All exports are pure
 * functions (no I/O, no logging, no secrets) so they are fully unit-testable.
 *
 * ```ts
 * import { contentDisposition, contentTypeForExt, parseRange } from "@minostack/mino/file";
 *
 * // Download with an inferred content-type:
 * app.get("/report", (c) =>
 *   c.file(new Uint8Array([1, 2, 3]), { filename: "report.pdf" }),
 * );
 *
 * // Single-range parsing for static handlers:
 * const r = parseRange(c.header("range"), size);
 * if (r === "unsatisfiable") {
 *   return new Response(null, {
 *     status: 416,
 *     headers: { "content-range": `bytes *\/${size}` },
 *   });
 * }
 * ```
 *
 * Error shape (where this module is used inside handlers) stays
 * `{error,status,code}` JSON — see `static.ts` / `mino.ts`.
 *
 * `If-Range` itself is evaluated in `static.ts` (against `ETag` /
 * `Last-Modified`); this module only parses `Range` headers.
 */

const EXT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "text/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

/**
 * Map a file path to a `content-type` via its extension.
 * Unknown or missing extensions fall back to `application/octet-stream`.
 *
 * ```ts
 * contentTypeForExt("app.js"); // "text/javascript; charset=utf-8"
 * contentTypeForExt("noext"); // "application/octet-stream"
 * ```
 */
export function contentTypeForExt(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  return EXT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Build a `Content-Disposition` value with an RFC 5987 `filename*` part
 * (UTF-8 percent-encoded) plus a quoted ASCII fallback.
 *
 * ```ts
 * contentDisposition("report.pdf");
 * // 'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf'
 * contentDisposition("résumé.pdf", "inline");
 * // 'inline; filename="r_sum_.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf'
 * ```
 *
 * CR/LF and double quotes are stripped (header-injection safe). An empty
 * name after stripping throws a plain `Error`.
 */
export function contentDisposition(
  filename: string,
  disposition: "attachment" | "inline" = "attachment",
): string {
  const clean = filename.replace(/[\r\n"]/g, "");
  if (clean.trim().length === 0) {
    throw new Error("filename must not be empty");
  }
  const fallback = clean.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/[!'()*]/g, (ch) => {
    return `%${ch.charCodeAt(0).toString(16).toUpperCase()}`;
  });
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Result of {@link parseRange}. */
export type ParsedRange =
  { start: number; end: number } | "multipart" | "unsatisfiable" | "invalid";

/** Result of {@link parseRangeList}. */
export type ParsedRangeList =
  Array<{ start: number; end: number }> | "unsatisfiable" | "invalid" | "too-many";

/**
 * Parse an HTTP `Range` header for `bytes=` single ranges.
 *
 * ```ts
 * parseRange("bytes=0-99", 200); // { start: 0, end: 99 }
 * parseRange("bytes=50-", 200); // { start: 50, end: 199 }
 * parseRange("bytes=-10", 200); // { start: 190, end: 199 }
 * parseRange("bytes=0-1, 2-3", 200); // "multipart"
 * parseRange("bytes=500-600", 200); // "unsatisfiable"
 * ```
 *
 * Rules: `s-` (open-ended) runs to `size - 1`; `-N` (suffix) returns the
 * last N bytes (`N = 0` → `"invalid"`); multiple ranges (comma) →
 * `"multipart"` (caller serves 200 full); garbage → `"invalid"`;
 * `start >= size` → `"unsatisfiable"`. When `size` is unknown (`undefined`)
 * the result is never `"unsatisfiable"` — single ranges return `"invalid"`
 * so the caller serves 200 full (legal to ignore Range).
 */
export function parseRange(header: string | null | undefined, size?: number): ParsedRange {
  if (typeof header !== "string") return "invalid";
  const trimmed = header.trim();
  const prefix = "bytes=";
  if (!trimmed.toLowerCase().startsWith(prefix)) return "invalid";
  const spec = trimmed.slice(prefix.length);
  if (spec.includes(",")) return "multipart";
  const match = /^(\d*)\s*-\s*(\d*)$/.exec(spec.trim());
  if (!match) return "invalid";
  const startStr = (match[1] ?? "").trim();
  const endStr = (match[2] ?? "").trim();
  if (startStr === "" && endStr === "") return "invalid";

  // Suffix range: last N bytes.
  if (startStr === "") {
    const n = Number(endStr);
    if (!Number.isSafeInteger(n) || n <= 0) return "invalid";
    if (size === undefined) return "invalid";
    if (n >= size) return { start: 0, end: size - 1 };
    return { start: size - n, end: size - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0) return "invalid";

  // Open-ended range: s- runs to the end.
  if (endStr === "") {
    if (size === undefined) return "invalid";
    if (start >= size) return "unsatisfiable";
    return { start, end: size - 1 };
  }

  const end = Number(endStr);
  if (!Number.isSafeInteger(end) || end < 0) return "invalid";
  if (end < start) return "invalid";
  if (size === undefined) return "invalid";
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Parse an HTTP `Range` header for `bytes=` into ALL ranges.
 *
 * ```ts
 * parseRangeList("bytes=0-1, 5-6", 10); // [{start:0,end:1},{start:5,end:6}]
 * parseRangeList("bytes=0-1, 50-60", 10); // "unsatisfiable"
 * ```
 *
 * Rules (mirrors {@link parseRange} per set): `s-` runs to `size - 1`;
 * `-N` returns the last N bytes (`N = 0` → `"invalid"`, `N >= size`
 * clamps to `0..size-1`); garbage in ANY set → `"invalid"`; any
 * `start >= size` (size known) → `"unsatisfiable"` for the WHOLE header
 * per RFC 9110 (unsatisfiable wins over valid sets; `"invalid"` wins over
 * `"unsatisfiable"` so garbage never yields `416`); `size` unknown
 * (`undefined`) → `"invalid"` (caller serves 200 full, legal to ignore
 * Range); `count > maxRanges` → `"too-many"` (caller serves 200 full,
 * documented in `static.ts`).
 */
export function parseRangeList(
  header: string,
  size: number | undefined,
  maxRanges = 8,
): ParsedRangeList {
  if (typeof header !== "string") return "invalid";
  const trimmed = header.trim();
  const prefix = "bytes=";
  if (!trimmed.toLowerCase().startsWith(prefix)) return "invalid";
  // Size unknown: never satisfiable, never an error — caller serves 200.
  if (size === undefined) return "invalid";
  const spec = trimmed.slice(prefix.length);
  const parts = spec.split(",");
  const out: Array<{ start: number; end: number }> = [];
  let sawUnsatisfiable = false;
  for (const raw of parts) {
    const part = raw.trim();
    const match = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (!match) return "invalid";
    const startStr = (match[1] ?? "").trim();
    const endStr = (match[2] ?? "").trim();
    if (startStr === "" && endStr === "") return "invalid";

    // Suffix range: last N bytes.
    if (startStr === "") {
      const n = Number(endStr);
      if (!Number.isSafeInteger(n) || n <= 0) return "invalid";
      if (n >= size) {
        out.push({ start: 0, end: size - 1 });
        continue;
      }
      out.push({ start: size - n, end: size - 1 });
      continue;
    }

    const start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0) return "invalid";

    // Open-ended range: s- runs to the end.
    if (endStr === "") {
      if (start >= size) {
        sawUnsatisfiable = true;
        continue;
      }
      out.push({ start, end: size - 1 });
      continue;
    }

    const end = Number(endStr);
    if (!Number.isSafeInteger(end) || end < 0) return "invalid";
    if (end < start) return "invalid";
    if (start >= size) {
      sawUnsatisfiable = true;
      continue;
    }
    out.push({ start, end: Math.min(end, size - 1) });
  }
  if (sawUnsatisfiable) return "unsatisfiable";
  if (out.length === 0) return "invalid";
  if (out.length > maxRanges) return "too-many";
  return out;
}

/**
 * Format a `Content-Range` response header value.
 *
 * ```ts
 * formatContentRange(0, 99, 200); // "bytes 0-99/200"
 * ```
 */
export function formatContentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}
