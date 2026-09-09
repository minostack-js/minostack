/**
 * `@minostack/mino/request-id` — request IDs + structured access logging.
 *
 * Zero dependencies, runtime-agnostic.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { requestId, logger } from "@minostack/mino/request-id";
 *
 * const app = new Mino();
 * app.use(requestId(), logger());
 * ```
 */

import type { Handler } from "./types.js";

export const REQUEST_ID_STATE_KEY = "requestId";
const MAX_INCOMING_ID_CHARS = 128;
// Conservative token shape: rejects CRLF/control injection outright.
const SAFE_ID = /^[A-Za-z0-9\-_.~:]{1,128}$/;

export interface RequestIdOptions {
  /** Header to read/echo (default `x-request-id`). */
  header?: string;
  /** Custom generator (default `crypto.randomUUID()` with `Math.random` fallback). */
  generate?: () => string;
  /** Echo the ID on responses (default true). */
  expose?: boolean;
}

function defaultGenerate(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    // fall through to Math.random fallback (non-secure contexts)
  }
  const hex = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  return `${hex()}-${hex().slice(0, 4)}-4${hex().slice(1, 4)}-${hex().slice(0, 4)}-${hex()}${hex().slice(0, 4)}`;
}

export function requestId(opts: RequestIdOptions = {}): Handler {
  const header = opts.header ?? "x-request-id";
  const generate = opts.generate ?? defaultGenerate;
  const expose = opts.expose ?? true;

  return async (c, next) => {
    const incoming = c.header(header);
    // Unsanitary incoming IDs are discarded, never echoed or stored raw.
    const id =
      incoming !== undefined && SAFE_ID.test(incoming) && incoming.length <= MAX_INCOMING_ID_CHARS
        ? incoming
        : generate();
    c.set(REQUEST_ID_STATE_KEY, id);
    await next();
    if (expose && c.res) {
      const h = new Headers(c.res.headers);
      if (!h.has(header)) h.set(header, id);
      // NOTE: return (not just setResponse) — compose() prefers nextResult.
      const out = new Response(c.res.body, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: h,
      });
      c.setResponse(out);
      return out;
    }
  };
}

// `logger` (+ `AccessLogEntry` / `LoggerOptions`) lives in `./logger.js` —
// re-exported here so `import { logger } from "@minostack/mino/request-id"`
// keeps working unchanged.
export { logger } from "./logger.js";
export type { AccessLogEntry, LoggerOptions } from "./logger.js";
