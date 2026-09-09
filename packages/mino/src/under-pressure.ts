/**
 * `@minostack/mino/under-pressure` — event-loop lag + heap overload guard.
 *
 * Zero dependencies, runtime-agnostic (`setTimeout`/`setInterval` + optional
 * `performance.memory` only — no `node:*` imports).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { underPressure, createPressureMonitor } from "@minostack/mino/under-pressure";
 *
 * const app = new Mino();
 * app.use(underPressure({ maxLagMs: 100, maxHeapMB: 512, retryAfterSec: 5 }));
 *
 * // Share a monitor with health endpoints (each underPressure() call owns
 * // its own monitor — single-instance usage per app).
 * const monitor = createPressureMonitor({ maxHeapMB: 512 });
 * app.get("/health", (c) => c.json(monitor.sample()));
 * ```
 *
 * Event-loop lag is measured by `setTimeout(0)` drift on a background interval
 * (unref'd, like `timeout.ts`); overload compares the rolling max of the last
 * 5 samples against `maxLagMs` (default 100). Heap uses `opts.heapSample()`
 * when provided, else `performance.memory.usedJSHeapSize` when the runtime
 * exposes it, else the heap check is disabled.
 *
 * Middleware contract: on overload it rebuilds a `503
 * {code:"server_overloaded"}` (+ `Retry-After`) WITHOUT calling `next()` and
 * returns it; otherwise it awaits `next()` and returns nothing (the downstream
 * response propagates via context).
 */

import type { Handler } from "./types.js";

export interface UnderPressureOptions {
  /** Rolling-max event-loop lag budget in ms (default 100). */
  maxLagMs?: number;
  /** Heap budget in MiB (default: unset = heap check disabled unless measurable). */
  maxHeapMB?: number;
  /** Heap reading in MiB; `undefined` disables the heap check for that sample. */
  heapSample?: () => number | undefined;
  /** Sampler cadence in ms (default 250). */
  intervalMs?: number;
  /** `Retry-After` seconds on 503 (default 5). */
  retryAfterSec?: number;
}

export interface PressureSample {
  /** Rolling-max event-loop lag in ms. */
  lagMs: number;
  /** Heap in MiB — absent when no reading is available. */
  heapMB?: number;
}

export interface PressureMonitor {
  isUnderPressure(): boolean;
  sample(): PressureSample;
  stop(): void;
}

const LAG_WINDOW = 5;
const BYTES_PER_MIB = 1048576;

function readHeapMB(heapSample: (() => number | undefined) | undefined): number | undefined {
  if (heapSample !== undefined) return heapSample();
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: unknown } }).memory;
    if (mem === undefined) return undefined;
    const bytes = mem.usedJSHeapSize;
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) return undefined;
    return bytes / BYTES_PER_MIB;
  } catch {
    return undefined;
  }
}

export function createPressureMonitor(opts: UnderPressureOptions = {}): PressureMonitor {
  const maxLagMs = opts.maxLagMs ?? 100;
  const maxHeapMB = opts.maxHeapMB;
  const heapSample = opts.heapSample;
  const intervalMs = opts.intervalMs ?? 250;
  const lags: number[] = [];

  const tick = (): void => {
    const start = Date.now();
    setTimeout(() => {
      const lag = Date.now() - start;
      lags.push(lag);
      if (lags.length > LAG_WINDOW) lags.shift();
    }, 0);
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  // Don't hold the process open for the sampler in Node runtimes.
  (timer as unknown as { unref?: () => void }).unref?.();

  const maxLag = (): number => {
    let peak = 0;
    for (const lag of lags) {
      if (lag > peak) peak = lag;
    }
    return peak;
  };

  return {
    isUnderPressure(): boolean {
      if (maxLag() > maxLagMs) return true;
      if (maxHeapMB !== undefined) {
        const heapMB = readHeapMB(heapSample);
        if (heapMB !== undefined && heapMB > maxHeapMB) return true;
      }
      return false;
    },
    sample(): PressureSample {
      const sample: PressureSample = { lagMs: maxLag() };
      const heapMB = readHeapMB(heapSample);
      if (heapMB !== undefined) sample.heapMB = heapMB;
      return sample;
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}

export function underPressure(opts: UnderPressureOptions = {}): Handler {
  const monitor = createPressureMonitor(opts);
  const retryAfterSec = opts.retryAfterSec ?? 5;
  return async (c, next) => {
    if (monitor.isUnderPressure()) {
      const res = new Response(
        JSON.stringify({ error: "Service Unavailable", status: 503, code: "server_overloaded" }),
        {
          status: 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "retry-after": String(retryAfterSec),
          },
        },
      );
      c.setResponse(res);
      return res;
    }
    await next();
  };
}
