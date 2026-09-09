/**
 * `@minostack/mino/health` — standard liveness/readiness (plan P3.1).
 *
 * Zero dependencies, runtime-agnostic. Liveness is a static 200; readiness
 * runs caller-owned dependency checks with per-check timeouts and result
 * caching. Check details are caller-controlled — never leak internals.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { live, ready } from "@minostack/mino/health";
 *
 * const app = new Mino();
 * app.get("/live", live());
 * app.get("/ready", ready({ checks: { db: () => db.ping() } }));
 * ```
 */

import type { Handler } from "./types.js";

export interface HealthCheckResult {
  healthy: boolean;
  /** Caller-controlled detail (latency, version — never secrets/stacks) */
  detail?: string;
}

export type HealthCheck = () => boolean | HealthCheckResult | Promise<boolean | HealthCheckResult>;

export interface ReadyOptions {
  /** Named dependency checks (db, cache, upstream, storage) */
  checks?: Record<string, HealthCheck>;
  /** Per-check budget in ms (default 1000). Slow checks count as unhealthy. */
  timeoutMs?: number;
  /** Cache aggregated results for `cacheMs` (default 0 = no cache). */
  cacheMs?: number;
  /** `Retry-After` seconds on 503 (default 5). */
  retryAfterSec?: number;
  now?: () => number;
}

export interface ReadyReport {
  status: "ready" | "not-ready";
  checks: Record<string, HealthCheckResult>;
}

/** Liveness: process/application alive. Static 200, safe to bypass auth. */
export function live(): Handler {
  return async (c) => c.json({ status: "alive" });
}

function normalize(result: boolean | HealthCheckResult): HealthCheckResult {
  return typeof result === "boolean" ? { healthy: result } : result;
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<HealthCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => check()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health check timed out")), timeoutMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
    return normalize(result);
  } catch {
    return { healthy: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Create a readiness evaluator with result caching. */
export function createReadinessMonitor(opts: ReadyOptions = {}): {
  check: () => Promise<ReadyReport>;
} {
  const checks = opts.checks ?? {};
  const timeoutMs = opts.timeoutMs ?? 1000;
  const cacheMs = Math.max(0, opts.cacheMs ?? 0);
  const now = opts.now ?? Date.now;
  let cached: { at: number; report: ReadyReport } | undefined;

  return {
    async check(): Promise<ReadyReport> {
      if (cached && now() - cached.at < cacheMs) return cached.report;
      const entries = Object.entries(checks);
      const results = await Promise.all(
        entries.map(async ([name, check]) => [name, await runCheck(check, timeoutMs)] as const),
      );
      const checksOut: Record<string, HealthCheckResult> = {};
      let allHealthy = true;
      for (const [name, result] of results) {
        checksOut[name] = result;
        if (!result.healthy) allHealthy = false;
      }
      const report: ReadyReport = { status: allHealthy ? "ready" : "not-ready", checks: checksOut };
      if (cacheMs > 0) cached = { at: now(), report };
      return report;
    },
  };
}

/**
 * Readiness handler. 200 `{status:"ready", checks}` when every dependency is
 * healthy, else 503 `{error, status:503, code:"not_ready"}` + `Retry-After`.
 * Exposes no sensitive data — only the check names and caller details.
 */
export function ready(opts: ReadyOptions = {}): Handler {
  const monitor = createReadinessMonitor(opts);
  const retryAfterSec = opts.retryAfterSec ?? 5;
  return async (c) => {
    const report = await monitor.check();
    if (report.status === "ready") return c.json(report);
    return c.json(
      { error: "Service Not Ready", status: 503, code: "not_ready", checks: report.checks },
      503,
      { "retry-after": String(retryAfterSec) },
    );
  };
}
