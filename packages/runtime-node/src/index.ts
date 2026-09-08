/**
 * @minostack/runtime-node — Direct Web-to-Node Stream Adapter.
 * Low-overhead bridge between Node.js http primitives and Mino's Fetch-native handler.
 */

import type { Mino } from "@minostack/mino";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

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
