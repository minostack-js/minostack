/**
 * Precompiled (but correctness-first) middleware pipeline.
 * Compiles an array of handlers into a single async function with `next()` semantics.
 * Future optimization: generate flat switch/loop code to avoid per-request `next` closures.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";

function isResponse(v: unknown): v is Response {
  // Fast path: same-realm Response (99% of hot path). Avoids property
  // lookups + `in` checks per middleware per request.
  if (typeof Response !== "undefined" && v instanceof Response) return true;
  if (typeof v !== "object" || v === null) return false;
  // Cross-realm fallback (e.g., node:fetch polyfill, Workers, vm contexts)
  const o = v as Record<string, unknown>;
  return (
    typeof o["status"] === "number" &&
    typeof o["headers"] === "object" &&
    o["headers"] !== null &&
    typeof (o as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

export function compose(handlers: Handler[]): (c: Context) => Promise<Response> {
  // Pre-validate: ensure handlers is non-empty
  if (handlers.length === 0) {
    return async () => new Response("Not Found", { status: 404 });
  }

  // Return the precompiled execution function — request-time only needs to dispatch.
  return async (c: Context): Promise<Response> => {
    let index = -1;

    const dispatch = async (i: number): Promise<Response | void> => {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      const fn = handlers[i];
      if (!fn) {
        // No more handlers — return whatever is on context or 404
        if (c.res) return c.res;
        return undefined;
      }

      let nextCalled = false;
      let nextResult: Response | void = undefined;

      const next = async (): Promise<void> => {
        if (nextCalled) throw new Error("next() called multiple times in same handler");
        nextCalled = true;
        nextResult = (await dispatch(i + 1)) as Response | void;
        // If next produced a response, propagate to context
        if (isResponse(nextResult)) {
          c.setResponse(nextResult);
        }
      };

      // Unified handler: (c, next) — handlers that ignore `next` just don't call it.
      // We always pass `next`; if they don't call it, we handle accordingly.
      const result = (await (fn as Handler)(c, next)) as unknown;

      // If handler returned a Response directly, short-circuit
      if (isResponse(result)) {
        c.setResponse(result);
        return result;
      }

      // If handler called next() and next produced a response, return it.
      // MIDDLEWARE CONTRACT: a middleware that mutates c.res after next()
      // (e.g. helmet/cors adding headers) MUST also return the new Response.
      // nextResult (the downstream response) wins here; a bare setResponse
      // without return is silently discarded by this branch.
      if (nextCalled) {
        if (isResponse(nextResult)) return nextResult;
        if (isResponse(c.res)) return c.res;
        if (result === undefined && c.res) return c.res;
        return nextResult;
      }

      // Handler did not call next() and did not return Response.
      // Strict contract: never auto-advance — see throw below.
      // Hardening: a defined non-Response return is a handler contract violation
      // (Handler type is Response | void). Fail closed via errorHandler → 500
      // instead of leaking a string/object where fetch callers expect Response.
      if (isResponse(c.res)) return c.res;
      if (result !== undefined) {
        throw new Error("Handler must return a Response or void");
      }

      // Strict contract: a non-terminal handler that neither returned a
      // Response nor called next() is a bug — fail closed (500 via
      // errorHandler) instead of silently auto-advancing and masking it.
      // Terminal handlers fall through to the 404 fallback below.
      if (i + 1 < handlers.length) {
        throw new Error("Handler must return a Response or call next()");
      }

      return undefined;
    };

    const response = (await dispatch(0)) as unknown;
    if (isResponse(response)) return response;
    if (isResponse(c.res)) return c.res;
    // Fallback — no handler returned a Response
    return new Response("Not Found", { status: 404 });
  };
}
