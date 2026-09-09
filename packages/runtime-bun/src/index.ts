/**
 * @minostack/runtime-bun — Bun adapter for @minostack/mino.
 * Uses Bun's native Fetch handler.
 */

import type { Mino } from "@minostack/mino";
import type { StaticLoader } from "@minostack/mino/static";

export type BunServeOptions = {
  port?: number;
  hostname?: string;
  /**
   * Bun-specific: development flag, reusePort, etc.
   */
  development?: boolean;
  reusePort?: boolean;
};

// Minimal typing for Bun global without requiring @types/bun at build time
type BunServer = {
  stop: (force?: boolean) => void;
  port: number;
  hostname: string;
};

declare const Bun:
  | {
      serve: (opts: {
        port?: number;
        hostname?: string;
        fetch: (req: Request) => Response | Promise<Response>;
        development?: boolean;
        reusePort?: boolean;
        error?: (err: Error) => Response | Promise<Response>;
      }) => BunServer;
    }
  | undefined;

/**
 * Serve a Mino app on Bun.
 */
export function serve(app: Pick<Mino, "fetch">, options: BunServeOptions = {}): BunServer {
  const { port = 3000, hostname = "0.0.0.0", development, reusePort } = options;

  if (typeof Bun !== "undefined" && Bun.serve) {
    const server = Bun.serve({
      port,
      hostname,
      development,
      reusePort,
      fetch: (req: Request) => app.fetch(req),
      error(err) {
        console.error("[runtime-bun] unhandled error:", err);
        return new Response("Internal Server Error", { status: 500 });
      },
    });
    return server;
  }

  throw new Error(
    "Bun runtime not available. Use @minostack/runtime-node on Node.js or run on Bun.",
  );
}

/**
 * Create a fetch handler for Bun (or any Fetch-compatible runtime).
 * Alias for `app.fetch` with proper `this` binding.
 */
export function toFetchHandler(app: Pick<Mino, "fetch">): (req: Request) => Promise<Response> {
  return (req: Request) => app.fetch(req);
}

// Minimal typing for `Bun.file` without requiring `@types/bun` at build time.
type BunLoaderFile = {
  exists(): Promise<boolean>;
  stream(): ReadableStream<Uint8Array>;
  slice(start: number, end: number): Pick<BunLoaderFile, "stream">;
  lastModified: number;
  size: number;
};

/**
 * Filesystem loader for `@minostack/mino/static` on Bun (`Bun.file`).
 * Streams bytes (`file.stream()`) instead of buffering.
 * Paths are confined to `root`; escapes resolve to `undefined`.
 *
 * When `range` is given, the stream carries exactly bytes `[start..end]`
 * (inclusive, via `file.slice(start, end + 1).stream()`) while `size`
 * stays the FULL file size.
 */
export function createBunLoader(root: string): StaticLoader {
  const base = root.replace(/\/+$/, "");
  return {
    async load(path: string, range?: { start: number; end: number }) {
      if (path.includes("..") || path.includes("\\")) return undefined;
      if (typeof Bun === "undefined") return undefined;
      const file = (Bun as unknown as { file: (p: string) => BunLoaderFile }).file(
        `${base}${path.startsWith("/") ? path : `/${path}`}`,
      );
      let exists = false;
      try {
        exists = await file.exists();
      } catch {
        return undefined;
      }
      if (!exists) return undefined;
      const source = range === undefined ? file : file.slice(range.start, range.end + 1);
      return {
        body: source.stream() as unknown as BodyInit,
        mtime: new Date(file.lastModified),
        size: file.size,
      };
    },
  };
}
