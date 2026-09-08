/**
 * Guards, Pipes, Interceptors — disciplined enterprise concepts.
 */

import type { ExecutionContext } from "./execution-context.js";

// ─────────────────────────────────────────────────────────────────
// Guards — determine whether execution is allowed
// ─────────────────────────────────────────────────────────────────

export interface Guard {
  canActivate(context: ExecutionContext): boolean | Promise<boolean>;
}

export type GuardType = (new (...args: unknown[]) => Guard) | Guard;

// ─────────────────────────────────────────────────────────────────
// Pipes — transform or validate inputs
// ─────────────────────────────────────────────────────────────────

export interface PipeTransform<T = unknown, R = unknown> {
  transform(value: T, metadata: PipeMetadata): R | Promise<R>;
}

export type PipeMetadata = {
  type: "param" | "query" | "body" | "custom";
  metatype?: unknown;
  data?: string;
};

// ─────────────────────────────────────────────────────────────────
// Interceptors — wrap execution
// ─────────────────────────────────────────────────────────────────

export interface CallHandler<T = unknown> {
  handle(): Promise<T>;
}

export interface Interceptor<T = unknown, R = unknown> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Promise<R> | R;
}

export type InterceptorType = (new (...args: unknown[]) => Interceptor) | Interceptor;

// Helpers to normalize
export async function runGuards(guards: Guard[], ctx: ExecutionContext): Promise<boolean> {
  for (const g of guards) {
    const can = await g.canActivate(ctx);
    if (!can) return false;
  }
  return true;
}

export async function runPipes<T>(
  pipes: PipeTransform[],
  value: T,
  meta: PipeMetadata,
): Promise<unknown> {
  let out: unknown = value;
  for (const p of pipes) out = await p.transform(out as T, meta);
  return out;
}

export async function runInterceptors<T>(
  interceptors: Interceptor[],
  ctx: ExecutionContext,
  handler: () => Promise<T>,
): Promise<T> {
  // Build chain from last to first
  let next: CallHandler<T> = { handle: handler };
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const interceptor = interceptors[i] as Interceptor<T, T>;
    const currentNext = next;
    next = {
      handle: () => Promise.resolve(interceptor.intercept(ctx, currentNext) as Promise<T>),
    };
  }
  return next.handle();
}
