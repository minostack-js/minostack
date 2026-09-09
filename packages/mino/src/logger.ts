/**
 * `@minostack/mino/logger` — structured access logging.
 *
 * Zero dependencies, runtime-agnostic.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { logger } from "@minostack/mino/logger";
 *
 * const app = new Mino();
 * app.use(logger());
 * ```
 *
 * Re-exported from `@minostack/mino/request-id` so existing
 * `import { logger } from "@minostack/mino/request-id"` keeps working.
 */

import type { Context } from "./context.js";
import { REQUEST_ID_STATE_KEY } from "./request-id.js";
import type { Handler } from "./types.js";

export interface AccessLogEntry {
  time: string;
  method: string;
  path: string;
  route?: string;
  status: number;
  ms: number;
  requestId?: string;
}

export interface LoggerOptions {
  /** Sink (default `console.info` JSON line). Inject your Pino/Winston/Sentry writer. */
  log?: (entry: AccessLogEntry) => void;
  /** Skip logging for these paths (e.g. health checks). */
  skip?: (c: Context) => boolean;
}

export function logger(opts: LoggerOptions = {}): Handler {
  const log = opts.log ?? ((entry: AccessLogEntry) => console.info(JSON.stringify(entry)));
  return async (c, next) => {
    if (opts.skip && opts.skip(c as unknown as Context)) {
      await next();
      return;
    }
    const start = performance.now();
    await next();
    const ms = performance.now() - start;
    // c.path triggers the lazy URL parse — acceptable: logging opts in.
    let path = "-";
    try {
      path = c.path;
    } catch {
      path = "-";
    }
    log({
      time: new Date().toISOString(),
      method: c.method,
      path,
      route: c.routePath,
      status: c.res?.status ?? 500,
      ms: Math.round(ms * 1000) / 1000,
      requestId: (c.get(REQUEST_ID_STATE_KEY) as string | undefined) ?? c.header("x-request-id"),
    });
  };
}
