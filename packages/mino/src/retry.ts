/**
 * `@minostack/mino/retry` — bounded retry with budgets (plan P2.1).
 *
 * Zero dependencies, runtime-agnostic. For outbound calls and upstream
 * fetches — NOT for re-running downstream handlers. Non-idempotent operations
 * are never retried unless you explicitly opt in via `shouldRetry`.
 *
 * ```ts
 * import { withRetry, isRetryableStatus } from "@minostack/mino/retry";
 *
 * const res = await withRetry(
 *   () => fetch("https://api.example.com/users"),
 *   { maxAttempts: 3, backoffMs: 200, shouldRetry: (e) => e instanceof TypeError },
 * );
 * ```
 *
 * Budgets: `maxAttempts` caps tries, `timeoutMs` caps total time. Backoff
 * doubles per attempt (`backoffMs * 2^(n-1)`) plus optional jitter.
 * `sleep`/`now` are injectable for deterministic tests.
 */

import { HttpError } from "./errors.js";

export interface RetryOptions {
  /** Max tries including the first (default 3). */
  maxAttempts?: number;
  /** Base backoff in ms, doubled per retry (default 100). */
  backoffMs?: number;
  /** Add up to `jitterMs` random ms per backoff (default 0 = deterministic). */
  jitterMs?: number;
  /** Overall budget in ms from the first attempt (default: none). */
  timeoutMs?: number;
  /**
   * Decide whether `error` (or a `Response` when `watchStatus` is set)
   * deserves another attempt. Default: retry thrown errors except
   * client-error `HttpError`s (4xx — retrying those is pointless).
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500;
  return true;
}

/** Status codes worth another attempt (408/429/502/503/504). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Run `fn` until it succeeds or budgets run out. The last error is rethrown
 * (never wrapped — callers keep the original status/code).
 */
export async function withRetry<T>(
  fn: (attempt: number) => T | Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoffMs = Math.max(0, opts.backoffMs ?? 100);
  const jitterMs = Math.max(0, opts.jitterMs ?? 0);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const deadline = opts.timeoutMs === undefined ? Infinity : now() + opts.timeoutMs;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      if (!shouldRetry(error, attempt)) break;
      if (now() >= deadline) break;
      let wait = backoffMs * 2 ** (attempt - 1);
      if (jitterMs > 0) wait += Math.random() * jitterMs;
      if (now() + wait > deadline) break;
      await sleep(wait);
    }
  }
  throw lastError;
}
