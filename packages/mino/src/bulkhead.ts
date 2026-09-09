/**
 * `@minostack/mino/bulkhead` — concurrency isolation (plan P2.3).
 *
 * Zero dependencies, runtime-agnostic. A `Bulkhead` caps concurrent executions
 * (`maxConcurrent`) plus bounded waiting (`maxQueue`); saturation rejects
 * fast with 429 `rate_limited` (+ `Retry-After`) instead of queueing
 * unboundedly. One saturated bulkhead never blocks unrelated routes.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { bulkhead } from "@minostack/mino/bulkhead";
 *
 * const app = new Mino();
 * app.post("/reports", bulkhead({ maxConcurrent: 4, maxQueue: 16 }), heavyHandler);
 * ```
 */

import type { Handler } from "./types.js";
import { TooManyRequestsError } from "./errors.js";

export interface BulkheadOptions {
  /** Max concurrent executions (default 10). */
  maxConcurrent?: number;
  /** Max waiters beyond `maxConcurrent` (default 0 = reject immediately). */
  maxQueue?: number;
  /** `Retry-After` seconds on 429 (default 1). */
  retryAfterSec?: number;
}

export interface BulkheadStats {
  active: number;
  queued: number;
}

export class Bulkhead {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly maxQueue: number;
  private readonly retryAfterSec: number;

  constructor(opts: BulkheadOptions = {}) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 10);
    this.maxQueue = Math.max(0, opts.maxQueue ?? 0);
    this.retryAfterSec = opts.retryAfterSec ?? 1;
  }

  stats(): BulkheadStats {
    return { active: this.active, queued: this.waiters.length };
  }

  /** Run `fn` under the bulkhead. Rejects with 429 when saturated. */
  async execute<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiters.length >= this.maxQueue) {
        throw new TooManyRequestsError("Bulkhead saturated", this.retryAfterSec);
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

/**
 * Middleware form — shares one bulkhead across every request that passes
 * through it. Saturation answers 429 without calling downstream.
 */
export function bulkhead(opts: BulkheadOptions = {}): Handler {
  const bh = new Bulkhead(opts);
  return async (c, next) => {
    await bh.execute(() => next());
  };
}
