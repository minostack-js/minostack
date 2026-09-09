/**
 * @minostack/runtime-deno — Deno adapter for @minostack/mino (experimental).
 * Target: Deno.serve and WinterCG-compatible edge runtimes.
 */

import type { Mino } from "@minostack/mino";
import type { StaticLoader } from "@minostack/mino/static";

export type DenoServeOptions = {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (info: { hostname: string; port: number }) => void;
};

type DenoServer = {
  finished: Promise<void>;
  shutdown: () => Promise<void>;
  addr: { hostname: string; port: number };
};

// Minimal typing for the Deno FS surface we use, without `@types/deno`.
type DenoSeekMode = "start" | "current" | "end";
type DenoFsFile = {
  read(p: Uint8Array): Promise<number | null>;
  seek(offset: number, whence: DenoSeekMode): Promise<number>;
  close(): void;
};

// Declare Deno global if available
declare const Deno:
  | {
      serve: (
        opts: {
          port?: number;
          hostname?: string;
          signal?: AbortSignal;
          onListen?: (info: { hostname: string; port: number }) => void;
        },
        handler: (req: Request) => Response | Promise<Response>,
      ) => DenoServer;
      stat: (path: string) => Promise<{ isFile: boolean; mtime: Date | null; size: number }>;
      open: (path: string, options?: { read?: boolean }) => Promise<DenoFsFile>;
    }
  | undefined;

/**
 * Serve a Mino app on Deno.
 */
export function serve(app: Pick<Mino, "fetch">, options: DenoServeOptions = {}): DenoServer {
  const { port = 3000, hostname = "0.0.0.0", signal, onListen } = options;

  if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
    const server = Deno.serve({ port, hostname, signal, onListen }, (req: Request) =>
      app.fetch(req),
    );
    return server;
  }

  throw new Error(
    "Deno runtime not available. Use @minostack/runtime-node on Node.js or run on Deno.",
  );
}

export function toFetchHandler(app: Pick<Mino, "fetch">): (req: Request) => Promise<Response> {
  return (req: Request) => app.fetch(req);
}

/**
 * Filesystem loader for `@minostack/mino/static` on Deno (`Deno.open` +
 * `ReadableStream` pump) — streams bytes instead of buffering.
 * Paths are confined to `root`; escapes and non-files resolve to `undefined`.
 *
 * When `range` is given, the file is `seek(start)`-ed and the stream
 * carries exactly bytes `[start..end]` (inclusive) while `size` stays the
 * FULL file size. The handle is always `close()`d (read loop `finally`
 * and stream `cancel`).
 */
export function createDenoLoader(root: string): StaticLoader {
  const base = root.replace(/\/+$/, "");
  return {
    async load(path: string, range?: { start: number; end: number }) {
      if (typeof Deno === "undefined") return undefined;
      if (path.includes("..") || path.includes("\\")) return undefined;
      const full = `${base}${path.startsWith("/") ? path : `/${path}`}`;
      const D = Deno;
      let st: { isFile: boolean; mtime: Date | null; size: number };
      try {
        st = await D.stat(full);
      } catch {
        return undefined;
      }
      if (!st.isFile) return undefined;
      const mtime = st.mtime ?? undefined;
      const size = st.size;
      // `null` total = full body; otherwise exactly `end - start + 1` bytes.
      const start = range?.start ?? 0;
      const total = range === undefined ? null : range.end - range.start + 1;
      let file: DenoFsFile | undefined;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const open = await D.open(full, { read: true });
            file = open;
            if (total !== null) await open.seek(start, "start");
            let remaining = total ?? Number.POSITIVE_INFINITY;
            const buf = new Uint8Array(64 * 1024);
            while (remaining > 0) {
              const view = remaining < buf.byteLength ? buf.subarray(0, remaining) : buf;
              const n = await open.read(view);
              if (n === null || n <= 0) break;
              remaining -= n;
              controller.enqueue(buf.slice(0, n));
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          } finally {
            try {
              file?.close();
            } catch {
              // ignore close failure after a read error
            }
            file = undefined;
          }
        },
        cancel() {
          try {
            file?.close();
          } catch {
            // ignore — start()'s finally closes as well
          }
        },
      });
      return { body: body as unknown as BodyInit, mtime, size };
    },
  };
}
