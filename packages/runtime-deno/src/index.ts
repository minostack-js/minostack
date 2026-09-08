/**
 * @minostack/runtime-deno — Deno adapter for @minostack/mino (experimental).
 * Target: Deno.serve and WinterCG-compatible edge runtimes.
 */

import type { Mino } from "@minostack/mino";

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
