/**
 * `@minostack/mino/timeout` — request-handler timeout middleware.
 *
 * Zero dependencies, runtime-agnostic (`setTimeout` only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { timeout } from "@minostack/mino/timeout";
 *
 * const app = new Mino();
 * app.use(timeout(5000));
 * ```
 *
 * When the downstream chain takes longer than `ms`, the client gets `408`.
 * Slow downstream work is NOT aborted (Fetch handlers have no cancellation
 * channel) — the 408 is re-asserted after `next()` settles so a late
 * `setResponse` cannot overwrite it. Pair with `AbortSignal` plumbing for
 * cooperative cancellation of your own async work.
 */

import type { Handler } from "./types.js";

export interface TimeoutOptions {
  /** Override status (default 408). */
  status?: number;
  /** Override message (default "Request Timeout"). */
  message?: string;
  /** Override machine-readable code (default "request_timeout"). */
  code?: string;
}

export function timeout(ms: number, opts: TimeoutOptions = {}): Handler {
  const status = opts.status ?? 408;
  const message = opts.message ?? "Request Timeout";
  const code = opts.code ?? "request_timeout";

  const tooLate = () =>
    new Response(JSON.stringify({ error: message, status, code }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  return async (c, next) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      c.setResponse(tooLate());
    }, ms);
    // Don't hold the process open for the timer in Node runtimes.
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      await next();
    } finally {
      clearTimeout(timer);
    }
    // Late downstream responses must not overwrite the 408 already sent.
    // NOTE: return (not just setResponse) — compose() prefers nextResult.
    if (timedOut) {
      const late = tooLate();
      c.setResponse(late);
      return late;
    }
  };
}
