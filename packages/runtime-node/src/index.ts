/**
 * @minostack/runtime-node — Direct Web-to-Node Stream Adapter.
 * Low-overhead bridge between Node.js http primitives and Mino's Fetch-native handler.
 */

import type { Mino } from "@minostack/mino";
import type { StaticLoader } from "@minostack/mino/static";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────
// Fetch Request <-> Node conversion
// ─────────────────────────────────────────────────────────────────

/**
 * Convert Node IncomingMessage to a Fetch Request.
 * Minimizes buffering — streams body when possible.
 */
export function toRequest(
  nodeReq: IncomingMessage,
  opts: { host?: string; signal?: AbortSignal } = {},
): Request {
  const { method = "GET", url = "/", headers: nodeHeaders } = nodeReq;
  const host = opts.host ?? (nodeHeaders.host as string) ?? "localhost";
  const protocol = (nodeReq.socket as unknown as { encrypted?: boolean })?.encrypted
    ? "https:"
    : "http:";
  const fullUrl = url.startsWith("http") ? url : `${protocol}//${host}${url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  // Server-set peer IP for downstream trust decisions (rate limiting, logs).
  // `set` overwrites any client-sent `x-mino-peer` value — never trust the wire.
  // Contract for all runtime adapters: overwrite from the socket when known.
  const peerIp = (nodeReq.socket as unknown as { remoteAddress?: unknown })?.remoteAddress;
  if (typeof peerIp === "string" && peerIp.length > 0) {
    headers.set("x-mino-peer", peerIp);
  }

  // Body handling: for GET/HEAD, no body
  if (method === "GET" || method === "HEAD") {
    const init: RequestInit = { method, headers, signal: opts.signal };
    return new Request(fullUrl, init);
  }

  // Stream body via Readable -> ReadableStream
  // Node's IncomingMessage is a Readable stream
  const stream = nodeReq as unknown as Readable;
  let readable: ReadableStream<Uint8Array> | undefined;
  if (!stream.readableEnded && stream.readable) {
    readable = new ReadableStream<Uint8Array>({
      start(controller) {
        const onData = (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk));
        const onEnd = () => {
          controller.close();
          cleanup();
        };
        const onError = (err: unknown) => {
          controller.error(err);
          cleanup();
        };
        const onAbort = () => {
          controller.error(new DOMException("Request aborted", "AbortError"));
          cleanup();
        };
        const cleanup = () => {
          stream.off("data", onData);
          stream.off("end", onEnd);
          stream.off("error", onError);
          stream.off("close", onAbort);
          opts.signal?.removeEventListener("abort", onAbort);
        };
        stream.on("data", onData);
        stream.on("end", onEnd);
        stream.on("error", onError);
        stream.on("close", onAbort);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        // If already ended, close immediately
        if ((stream as unknown as { readableEnded: boolean }).readableEnded) {
          controller.close();
          cleanup();
        }
        // If signal already aborted, error
        if (opts.signal?.aborted) {
          onAbort();
        }
      },
      cancel() {
        stream.destroy();
      },
    });
  }

  // Node's Request requires duplex: half when streaming body
  const init: RequestInit & { duplex?: string; signal?: AbortSignal } = {
    method,
    headers,
    body: readable as unknown as BodyInit | undefined,
    duplex: readable ? "half" : undefined,
    signal: opts.signal,
  };

  return new Request(fullUrl, init);
}

/**
 * Write a Fetch Response to a Node ServerResponse.
 * Handles streaming bodies efficiently without full buffering when possible.
 */
export async function toNodeResponse(fetchRes: Response, nodeRes: ServerResponse): Promise<void> {
  // Status
  nodeRes.statusCode = fetchRes.status;
  // Headers — preserve multiple Set-Cookie without comma coalescing
  // Fetch's Headers.forEach joins Set-Cookie with ", " (per spec) which mangles Expires=Thu, ...
  // Use getSetCookie() when available (Node's Fetch impl).
  const getSetCookie = (fetchRes.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(fetchRes.headers);
    if (cookies.length > 0) {
      nodeRes.setHeader("set-cookie", cookies);
    }
    fetchRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      nodeRes.setHeader(key, value);
    });
  } else {
    fetchRes.headers.forEach((value, key) => {
      // Fallback: best-effort split for impls without getSetCookie — still try to preserve separate cookies
      if (key.toLowerCase() === "set-cookie") {
        // Append each set-cookie
        const existing = nodeRes.getHeader("set-cookie");
        if (existing) {
          const arr = Array.isArray(existing) ? existing : [String(existing)];
          nodeRes.setHeader("set-cookie", [...arr, value]);
        } else {
          nodeRes.setHeader(key, value);
        }
      } else {
        nodeRes.setHeader(key, value);
      }
    });
  }

  if (fetchRes.body === null) {
    nodeRes.end();
    return;
  }

  // Stream body
  const reader = fetchRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const canContinue = nodeRes.write(value);
        if (!canContinue) {
          await new Promise<void>((resolve, reject) => {
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onError = (err: unknown) => {
              cleanup();
              reject(err);
            };
            const onClose = () => {
              cleanup();
              reject(new Error("Response closed"));
            };
            const cleanup = () => {
              nodeRes.off("drain", onDrain);
              nodeRes.off("error", onError);
              nodeRes.off("close", onClose);
            };
            nodeRes.once("drain", onDrain);
            nodeRes.once("error", onError);
            nodeRes.once("close", onClose);
          });
        }
      }
    }
    nodeRes.end();
  } catch (err) {
    // Abort the stream
    try {
      nodeRes.destroy(err as Error);
    } catch (_e) {
      // ignore
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_e) {
      // ignore if already released
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Listener & Server
// ─────────────────────────────────────────────────────────────────

export type ServeOptions = {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  /**
   * Optional callback when server is listening.
   */
  onListen?: (info: { port: number; hostname: string }) => void;
  /**
   * Reuse an existing Node http Server? If provided, we attach listener to it.
   */
  server?: Server;
};

/**
 * Create a Node http request listener from a Mino app.
 */
export function createNodeRequestListener(
  app: Pick<Mino, "fetch">,
): (nodeReq: IncomingMessage, nodeRes: ServerResponse) => void {
  return (nodeReq, nodeRes) => {
    // Abort handling: if client disconnects, abort the Fetch request
    const ac = new AbortController();
    const onClose = () => ac.abort();
    if (typeof (nodeReq as unknown as { on?: unknown }).on === "function") {
      (nodeReq as unknown as { on: (e: string, cb: () => void) => void }).on("close", onClose);
    }
    // Also handle nodeReq errors
    const onReqError = () => ac.abort();
    if (typeof (nodeReq as unknown as { on?: unknown }).on === "function") {
      (nodeReq as unknown as { on: (e: string, cb: () => void) => void }).on("error", onReqError);
    }
    void (async () => {
      try {
        const req = toRequest(nodeReq, { signal: ac.signal });
        const res = await app.fetch(req);
        await toNodeResponse(res, nodeRes);
      } catch (err) {
        // If aborted, don't log as error — client disconnected
        if (ac.signal.aborted) {
          try {
            if (!nodeRes.writableEnded) nodeRes.destroy();
          } catch (_e) {
            // ignore destroy error on abort
          }
          return;
        }
        // Fallback 500 only if app.fetch threw beyond its own errorHandler (catastrophic)
        // app.fetch already catches handler errors and returns 500; this catch is for adapter failures
        // Log only in non-production or if needed; keep quiet to avoid noisy logs
        if (process.env.NODE_ENV !== "production") {
          console.error("[runtime-node] unhandled error in request listener:", err);
        }
        if (!nodeRes.headersSent) {
          nodeRes.statusCode = 500;
          nodeRes.setHeader("content-type", "text/plain");
        }
        if (!nodeRes.writableEnded) nodeRes.end("Internal Server Error");
      } finally {
        if (typeof (nodeReq as unknown as { off?: unknown }).off === "function") {
          (nodeReq as unknown as { off: (e: string, cb: () => void) => void }).off(
            "close",
            onClose,
          );
          (nodeReq as unknown as { off: (e: string, cb: () => void) => void }).off(
            "error",
            onReqError,
          );
        }
      }
    })();
  };
}

/**
 * Serve a Mino app on Node.js.
 * Returns the Node http.Server instance.
 *
 * ```ts
 * import { Mino } from "@minostack/mino"
 * import { serve } from "@minostack/runtime-node"
 *
 * const app = new Mino()
 * app.get("/", (c) => c.text("hello"))
 *
 * const server = serve(app, { port: 3000 })
 * ```
 */
export function serve(app: Pick<Mino, "fetch">, options: ServeOptions = {}): Server {
  const { port = 3000, hostname = "0.0.0.0", signal, onListen, server: existingServer } = options;

  const handler = createNodeRequestListener(app);

  let server: Server;
  if (existingServer) {
    server = existingServer;
    // Attach our handler to existing server; avoid duplicate if already listening with same handler
    server.on("request", handler);
    if (!server.listening) {
      server.listen(port, hostname, () => onListen?.({ port, hostname }));
    } else {
      // Already listening — still notify onListen asynchronously for consistency
      queueMicrotask(() => {
        const addr = server.address() as { port?: number } | null;
        onListen?.({ port: addr?.port ?? port, hostname });
      });
    }
  } else {
    server = createServer(handler);
    server.listen(port, hostname, () => {
      onListen?.({ port, hostname });
    });
  }

  if (signal) {
    const onAbort = () => {
      server.close();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return server;
}

/**
 * Helper to close server with Promise.
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Filesystem loader for `@minostack/mino/static` on Node.js.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { serveStatic } from "@minostack/mino/static";
 * import { createNodeLoader } from "@minostack/runtime-node";
 *
 * const app = new Mino();
 * app.use(serveStatic({ loader: createNodeLoader("./public"), prefix: "/static" }));
 * ```
 *
 * Streams file bytes (`Readable.toWeb(createReadStream(abs))`) instead of
 * buffering, so large assets never sit fully in memory.
 *
 * Paths are confined to `root` (resolved once); `..` escapes and non-files
 * resolve to `undefined` so `serveStatic` answers 403/404.
 *
 * When `range` is given, the stream carries exactly bytes `[start..end]`
 * (inclusive, via `createReadStream(abs, { start, end })`) while `size`
 * stays the FULL file size.
 */
export function createNodeLoader(root: string): StaticLoader {
  const base = resolve(root);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return {
    async load(path: string, range?: { start: number; end: number }) {
      const abs = resolve(join(base, `.${sep}${path}`));
      if (abs !== base && !abs.startsWith(prefix)) return undefined;
      let st: { isFile(): boolean; mtime: Date; size: number };
      try {
        st = await stat(abs);
      } catch {
        return undefined;
      }
      if (!st.isFile()) return undefined;
      const nodeStream =
        range === undefined
          ? createReadStream(abs)
          : createReadStream(abs, { start: range.start, end: range.end });
      return {
        body: Readable.toWeb(nodeStream) as unknown as BodyInit,
        mtime: st.mtime,
        size: st.size,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// WebSocket upgrade (Track C)
// ─────────────────────────────────────────────────────────────────

/**
 * RFC 6455 handshake GUID (mirrors `@minostack/mino/websocket`).
 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function hasWsToken(header: string | undefined, token: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => part.trim().toLowerCase() === token);
}

/**
 * Compute `base64(sha1(key + GUID))` via WebCrypto.
 * Implemented inline (instead of importing `@minostack/mino/websocket`, which
 * has no subpath export) so this adapter keeps zero extra dependencies.
 */
async function wsAcceptKey(key: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${key.trim()}${WS_GUID}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-1", bytes);
  const view = new Uint8Array(digest);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Raw socket handed to the upgrade handler after the 101 handshake.
 */
export interface UpgradeContext {
  /** Fetch Request built from the upgrade's HTTP headers (for routing/logging). */
  req: Request;
  /** Hijacked socket — framing policy lives in caller code using the `mino/websocket` codec. */
  socket: Socket;
  /** Bytes already read past the headers (usually empty; forward them to the parser first). */
  head: Uint8Array;
}

/**
 * Create a Node `upgrade` listener factory for raw WebSocket handling.
 *
 * ```ts
 * import { createServer } from "node:http";
 * import { Mino } from "@minostack/mino";
 * import { serve, createUpgradeListener } from "@minostack/runtime-node";
 * import { encodeFrame, createFrameParser, Opcode } from "@minostack/mino/websocket";
 *
 * const app = new Mino();
 * const server = serve(app, { port: 3000 });
 * server.on("upgrade", createUpgradeListener(app, ({ socket, head }) => {
 *   const parser = createFrameParser((frame) => {
 *     if (frame.opcode === Opcode.Ping) socket.write(encodeFrame({ opcode: Opcode.Pong, data: frame.data }));
 *   });
 *   if (head.byteLength > 0) parser.push(head);
 *   socket.on("data", (chunk) => parser.push(new Uint8Array(chunk)));
 * }));
 * ```
 *
 * Validates the upgrade (`GET` + `Upgrade: websocket` + non-empty
 * `Sec-WebSocket-Key` + `Sec-WebSocket-Version: 13`), writes the `101`
 * response bytes (including a negotiated `Sec-WebSocket-Protocol` echo of the
 * client's first offer), then hands the raw socket to `handler`. Invalid
 * upgrades get `400` + destroy; handshake failures destroy the socket.
 * Framing policy lives in caller code using the `mino/websocket` codec.
 */
export function createUpgradeListener(
  app: Pick<Mino, "fetch">,
  handler: (ctx: UpgradeContext) => void,
): (nodeReq: IncomingMessage, socket: Socket, head: Buffer) => void {
  // Reserved for future policy hooks (e.g. routing upgrades through app.fetch);
  // dispatch stays in the caller handler so adapters never impose framing.
  void app;
  return (nodeReq, socket, head) => {
    const headers = nodeReq.headers;
    const key = firstHeader(headers["sec-websocket-key"]);
    const valid =
      (nodeReq.method ?? "GET").toUpperCase() === "GET" &&
      hasWsToken(firstHeader(headers["upgrade"]), "websocket") &&
      key !== undefined &&
      key.trim().length > 0 &&
      (firstHeader(headers["sec-websocket-version"]) ?? "").trim() === "13";
    if (!valid || key === undefined) {
      try {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } catch {
        // ignore write failure on a dying socket
      }
      socket.destroy();
      return;
    }
    const upgradeKey = key;
    const protocol = firstHeader(headers["sec-websocket-protocol"])?.split(",")[0]?.trim();
    void (async () => {
      try {
        const accept = await wsAcceptKey(upgradeKey);
        const lines = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
        ];
        if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        handler({ req: toRequest(nodeReq), socket, head: new Uint8Array(head) });
      } catch {
        try {
          socket.destroy();
        } catch {
          // ignore destroy failure
        }
      }
    })();
  };
}

// ─────────────────────────────────────────────────────────────────
// Multipart disk sink
// ─────────────────────────────────────────────────────────────────

/**
 * Sanitize an uploader-supplied filename: cross-platform basename (both `/`
 * and `\` split), control characters stripped, `.`/`..`/empty fall back to a
 * random name. The result never contains a path separator.
 */
function sanitizeUploadFilename(raw: string | undefined): string {
  if (raw === undefined) return randomUUID();
  const base = basename(raw.replace(/\\/g, "/"));
  // Strip control characters without a control-regex (lint-clean).
  let clean = "";
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) continue;
    clean += ch;
  }
  clean = clean.trim();
  if (clean === "" || clean === "." || clean === "..") return randomUUID();
  return clean;
}

/**
 * Stream an async byte iterable (e.g. a `MultipartPart.body` from
 * `@minostack/mino/multipart`) to a file inside `dir` without buffering.
 *
 * ```ts
 * import { pipeToFile } from "@minostack/runtime-node";
 * import { parseMultipart } from "@minostack/mino/multipart";
 *
 * app.post("/upload", async (c) => {
 *   const saved: Array<{ name: string; path: string; size: number }> = [];
 *   for await (const part of parseMultipart(c.req)) {
 *     if (part.filename === undefined) continue;
 *     const { path, size } = await pipeToFile(part.body, "/var/uploads/tmp", {
 *       filename: part.filename,
 *       maxBytes: 5_242_880,
 *     });
 *     saved.push({ name: part.filename, path, size });
 *   }
 *   return c.json({ saved });
 * });
 * ```
 *
 * Confined to the resolved `dir` (`mkdir -p` when missing); `..` escapes are
 * impossible by construction (verified after resolution, defense in depth).
 * `maxBytes` is enforced MID-STREAM: on breach the partial file is unlinked
 * and a plain `Error` carrying `status = 413` is thrown — map `err.status`
 * to `{error, status, code}` JSON in your error handler (Mino's default
 * handler only maps `HttpError`, so translate there if you rely on it).
 * Any source/write error also unlinks the partial file, so failed uploads
 * never leave remnants. Nothing is logged — filenames may carry PII.
 */
export async function pipeToFile(
  stream: AsyncIterable<Uint8Array>,
  dir: string,
  opts: { filename?: string; maxBytes?: number } = {},
): Promise<{ path: string; size: number }> {
  const resolvedDir = resolve(dir);
  await mkdir(resolvedDir, { recursive: true });
  const name = sanitizeUploadFilename(opts.filename);
  const abs = resolve(join(resolvedDir, name));
  if (!abs.startsWith(resolvedDir + sep)) {
    // Unreachable via sanitizeUploadFilename (no separators survive), kept
    // as defense in depth against future refactors.
    throw new Error("Invalid upload filename");
  }
  const ws = createWriteStream(abs);
  // Persistent listener so a mid-write fs error never becomes uncaught.
  let streamError: unknown = null;
  ws.on("error", (err: unknown) => {
    streamError = err;
  });
  const destroyAndUnlink = async (err: unknown): Promise<never> => {
    try {
      ws.destroy();
    } catch {
      // ignore destroy failure on a dying stream
    }
    try {
      if (!ws.closed) {
        await new Promise<void>((resolveClose) => {
          ws.once("close", () => resolveClose());
        });
      }
    } catch {
      // never block error propagation on cleanup races
    }
    try {
      await unlink(abs);
    } catch {
      // ignore when nothing was written yet
    }
    throw err;
  };
  const overLimit = (): Error => {
    const err = new Error(`Upload exceeds limit of ${opts.maxBytes} bytes`);
    (err as unknown as { status?: number }).status = 413;
    return err;
  };
  try {
    let size = 0;
    for await (const chunk of stream) {
      if (streamError !== null) throw streamError;
      if (chunk.byteLength === 0) continue;
      size += chunk.byteLength;
      if (opts.maxBytes !== undefined && size > opts.maxBytes) {
        throw overLimit();
      }
      if (!ws.write(chunk)) {
        await new Promise<void>((resolveDrain, rejectDrain) => {
          ws.once("drain", () => resolveDrain());
          ws.once("error", (err: unknown) => rejectDrain(err));
        });
      }
    }
    if (streamError !== null) throw streamError;
    await new Promise<void>((resolveFinish, rejectFinish) => {
      ws.once("error", (err: unknown) => rejectFinish(err));
      ws.once("finish", () => resolveFinish());
      ws.end();
    });
    return { path: abs, size };
  } catch (err) {
    return destroyAndUnlink(err);
  }
}
