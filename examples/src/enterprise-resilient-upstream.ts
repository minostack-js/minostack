/**
 * Enterprise: resilient upstream integration (dev-mode preview).
 *
 * Retry budget + circuit breaker composed around a faked upstream fetch,
 * fronted by Mino's proxy. No real network involved.
 *
 * Expected: two transient failures then success; the breaker stays closed;
 * a persistently failing upstream opens the breaker and short-circuits.
 */

import { Mino } from "@minostack/mino";
import { proxy } from "@minostack/mino/proxy";
import { withRetry } from "@minostack/mino/retry";
import { CircuitBreaker } from "@minostack/mino/circuit-breaker";

export const upstreamCalls: string[] = [];
let failuresLeft = 2;

export async function flakyUpstream(url: string): Promise<Response> {
  upstreamCalls.push(url);
  if (failuresLeft-- > 0) return new Response("overloaded", { status: 503 });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });
}

export const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });

export async function resilientGet(url: string): Promise<Response> {
  return breaker.execute(() =>
    withRetry(
      async () => {
        const res = await flakyUpstream(url);
        if (res.status >= 500) throw new Error(`upstream ${res.status}`);
        return res;
      },
      { maxAttempts: 4, backoffMs: 1, sleep: async () => {} },
    ),
  );
}

export const app = new Mino();
app.all(
  "/upstream/*",
  proxy("https://upstream.example.com", {
    allowedTargets: ["https://upstream.example.com"],
    fetchFn: flakyUpstream,
  }),
);
