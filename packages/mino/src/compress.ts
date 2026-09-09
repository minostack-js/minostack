/**
 * `@minostack/mino/compress` — response compression middleware.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Response` + `CompressionStream` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { compress } from "@minostack/mino/compress";
 *
 * const app = new Mino();
 * app.use(compress());
 * ```
 *
 * Behavior: buffers the downstream response, skips when there is no body,
 * when `content-encoding` is already set, for SSE (`text/event-stream`),
 * for `HEAD` / `204` / `304`, when the client sends no compatible
 * `Accept-Encoding`, or when the body is smaller than `threshold`.
 * Otherwise compresses with `CompressionStream` (server preference:
 * `gzip` then `deflate`), sets `content-encoding` + `vary`, and fixes
 * `content-length` for the compressed bytes.
 */

import type { Handler } from "./types.js";

export type CompressEncoding = "gzip" | "deflate";

export interface CompressOptions {
  /** Minimum response bytes before compressing (default 1024). */
  threshold?: number;
  /** Server-allowed encodings, in server preference order (default `['gzip','deflate']`). */
  encodings?: CompressEncoding[];
}

const SERVER_PREFERENCE: readonly CompressEncoding[] = ["gzip", "deflate"];

/**
 * Parse `Accept-Encoding` into a set of tokens the client accepts.
 * Handles quality values (`gzip;q=0` means refused) and `*` wildcards.
 * Returns `null` when the header is absent.
 */
function parseAcceptEncoding(header: string | null): Set<string> | null {
  if (header === null) return null;
  const out = new Set<string>();
  for (const part of header.split(",")) {
    const [tokenRaw, ...params] = part.split(";");
    const token = tokenRaw?.trim().toLowerCase() ?? "";
    if (!token) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.split("=");
      if (k?.trim().toLowerCase() === "q") {
        const n = Number(v);
        if (Number.isFinite(n)) q = n;
      }
    }
    if (q <= 0) continue;
    out.add(token);
  }
  return out;
}

function pickEncoding(
  accepted: Set<string> | null,
  allowed: readonly CompressEncoding[],
): CompressEncoding | null {
  if (accepted === null || accepted.size === 0) return null;
  const allowsStar = accepted.has("*");
  for (const enc of SERVER_PREFERENCE) {
    if (!allowed.includes(enc)) continue;
    if (accepted.has(enc) || (allowsStar && !accepted.has(`${enc};q=0`))) return enc;
  }
  return null;
}

async function compressBytes(bytes: Uint8Array, encoding: CompressEncoding): Promise<Uint8Array> {
  const CS = (
    globalThis as unknown as {
      CompressionStream?: new (format: string) => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
    }
  ).CompressionStream;
  if (typeof CS === "undefined") throw new Error("CompressionStream unavailable");
  const source = new Response(bytes as unknown as BodyInit).body;
  if (!source) return bytes;
  const stream = source.pipeThrough(new CS(encoding));
  const buf = await new Response(stream as unknown as BodyInit).arrayBuffer();
  return new Uint8Array(buf);
}

export function compress(opts: CompressOptions = {}): Handler {
  const threshold = opts.threshold ?? 1024;
  const allowed = opts.encodings ?? ["gzip", "deflate"];

  return async (c, next) => {
    await next();
    const res = c.res;
    if (!res) return;
    // No body to compress (HEAD / 204 / 304 / empty).
    if (c.method === "HEAD") return;
    if (res.status === 204 || res.status === 304) return;
    if (res.body === null) return;
    // Never double-encode; never touch event streams (buffering one hangs).
    if (res.headers.has("content-encoding")) return;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) return;

    const accepted = parseAcceptEncoding(c.header("accept-encoding") ?? null);
    const encoding = pickEncoding(accepted, allowed);
    if (!encoding) return;

    // Fast path: trusted content-length below threshold skips without buffering.
    const declared = res.headers.get("content-length");
    if (declared !== null) {
      const n = Number(declared);
      if (Number.isFinite(n) && n < threshold) return;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      return;
    }
    if (bytes.byteLength < threshold || bytes.byteLength === 0) {
      // Body is consumed by buffering — rebuild identically to restore it.
      const h0 = new Headers(res.headers);
      const restored = new Response(bytes as unknown as BodyInit, {
        status: res.status,
        statusText: res.statusText,
        headers: h0,
      });
      c.setResponse(restored);
      return restored;
    }

    let compressed: Uint8Array;
    try {
      compressed = await compressBytes(bytes, encoding);
    } catch {
      // Compression failed — restore the buffered bytes instead of leaking
      // a consumed body to the client.
      const h0 = new Headers(res.headers);
      const restored = new Response(bytes as unknown as BodyInit, {
        status: res.status,
        statusText: res.statusText,
        headers: h0,
      });
      c.setResponse(restored);
      return restored;
    }

    const h = new Headers(res.headers);
    h.set("content-encoding", encoding);
    h.set("content-length", String(compressed.byteLength));
    const prevVary = h.get("vary");
    if (prevVary) {
      if (!prevVary.toLowerCase().includes("accept-encoding")) {
        h.set("vary", `${prevVary}, Accept-Encoding`);
      }
    } else {
      h.set("vary", "Accept-Encoding");
    }
    // Compressed bytes invalidate the strong validator for the identity body.
    h.delete("etag");
    // NOTE: return (not just setResponse) — compose() prefers nextResult.
    const out = new Response(compressed as unknown as BodyInit, {
      status: res.status,
      statusText: res.statusText,
      headers: h,
    });
    c.setResponse(out);
    return out;
  };
}
