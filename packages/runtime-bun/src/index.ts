/**
 * @minostack/runtime-bun — Bun adapter for @minostack/mino.
 * Uses Bun's native Fetch handler.
 */

import type { Mino } from "@minostack/mino";

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
