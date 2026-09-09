/**
 * `@minostack/mino/circuit-breaker` — fail-fast short-circuit (plan P2.2).
 *
 * Zero dependencies, runtime-agnostic. Wraps outbound calls: after
 * `failureThreshold` consecutive failures the circuit opens and calls fail
 * immediately with `CircuitOpenError` (no upstream traffic) until
 * `resetTimeoutMs` elapses, then a bounded number of half-open probes decide
 * whether to close it again.
 *
 * ```ts
 * import { CircuitBreaker } from "@minostack/mino/circuit-breaker";
 *
 * const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });
 * const res = await breaker.execute(() => fetch(upstream));
 * ```
 *
 * Failure classification: thrown non-`HttpError`s and 5xx `HttpError`s count;
 * 4xx `HttpError`s are caller errors, not upstream failures, and never count.
 * Override with `isFailure`. `now` is injectable for deterministic tests.
 */

import { HttpError } from "./errors.js";

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  readonly state: CircuitState = "open";
  constructor() {
    super("Circuit is open");
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit (default 5). */
  failureThreshold?: number;
  /** Ms an open circuit waits before allowing probes (default 30_000). */
  resetTimeoutMs?: number;
  /** Successful half-open probes required to close (default 1). */
  halfOpenMaxCalls?: number;
  /** Custom failure classifier (default: 5xx/non-HttpError throws). */
  isFailure?: (error: unknown) => boolean;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  now?: () => number;
}

function defaultIsFailure(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500;
  return true;
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private halfOpenCalls = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly isFailure: (error: unknown) => boolean;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 5);
    this.resetTimeoutMs = Math.max(0, opts.resetTimeoutMs ?? 30_000);
    this.halfOpenMaxCalls = Math.max(1, opts.halfOpenMaxCalls ?? 1);
    this.isFailure = opts.isFailure ?? defaultIsFailure;
    this.onStateChange = opts.onStateChange;
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    if (this.state === "open" && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.transition("half-open");
      this.halfOpenCalls = 0;
    }
    return this.state;
  }

  /** Consecutive failure count (resets on success). Test/dev introspection. */
  get consecutiveFailures(): number {
    return this.failures;
  }

  async execute<T>(fn: () => T | Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === "open") throw new CircuitOpenError();
    if (state === "half-open") {
      this.halfOpenCalls++;
      if (this.halfOpenCalls > this.halfOpenMaxCalls) throw new CircuitOpenError();
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /** Force closed (e.g. after a deploy). Clears failure history. */
  reset(): void {
    this.failures = 0;
    this.transition("closed");
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === "half-open") this.transition("closed");
  }

  private onFailure(error: unknown): void {
    if (!this.isFailure(error)) return;
    this.failures++;
    if (this.state === "half-open") {
      this.openedAt = this.now();
      this.transition("open");
    } else if (this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.transition("open");
    }
  }

  private transition(to: CircuitState): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    this.onStateChange?.(from, to);
  }
}
