/**
 * `@minostack/mino/idempotency` — safe retries for unsafe methods (plan P2.4).
 *
 * Zero dependencies, runtime-agnostic. Clients send `Idempotency-Key`; the
 * first request executes and its response is stored, duplicates replay the
 * stored response without re-executing the handler, and a different payload
 * under the same key is rejected with 409 `conflict`.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { idempotency, MemoryIdempotencyStore } from "@minostack/mino/idempotency";
 *
 * const app = new Mino();
 * app.post("/pay", idempotency(new MemoryIdempotencyStore()), payHandler);
 * ```
 *
 * Scope: `POST`/`PUT`/`PATCH`/`DELETE` by default (safe methods pass
 * through). Requests without a key execute normally with no guarantee.
 * Fingerprint defaults to `method + url + key`; supply `fingerprint` to bind
 * the body (e.g. hash it in the handler layer — this middleware never buffers
 * bodies itself). Stored bodies are capped (`maxBodyBytes`, default 1MB);
 * oversized responses execute normally but are not stored.
 */

import type { Context } from "./context.js";
import type { Handler } from "./types.js";
import { ConflictError } from "./errors.js";

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  fingerprint: string;
}

export interface IdempotencyStore {
  get(key: string): StoredResponse | undefined | Promise<StoredResponse | undefined>;
  set(key: string, response: StoredResponse, ttlMs?: number): void | Promise<void>;
}

/** Single-process store with TTL expiry. Replace with a shared store for multi-instance. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private entries = new Map<string, { response: StoredResponse; exp?: number }>();
  private readonly now: () => number;

  constructor(opts: { clock?: { now(): number } } = {}) {
    this.now = opts.clock?.now ?? Date.now;
  }

  get(key: string): StoredResponse | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.exp !== undefined && e.exp <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.response;
  }

  set(key: string, response: StoredResponse, ttlMs?: number): void {
    this.entries.set(key, {
      response,
      exp: ttlMs === undefined ? undefined : this.now() + ttlMs,
    });
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface IdempotencyOptions {
  /** Header carrying the key (default `"idempotency-key"`). */
  header?: string;
  /** Methods guarded (default POST/PUT/PATCH/DELETE). */
  methods?: string[];
  /** Stored-response TTL in ms (default 24h). */
  ttlMs?: number;
  /** Max stored body in bytes (default 1MB). Larger responses aren't stored. */
  maxBodyBytes?: number;
  /** Bind the key to request content (default: method + url + key). */
  fingerprint?: (c: Context, key: string) => string;
  now?: () => number;
}

const DEFAULT_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

export function idempotency(store: IdempotencyStore, opts: IdempotencyOptions = {}): Handler {
  const header = (opts.header ?? "idempotency-key").toLowerCase();
  const methods = new Set((opts.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));
  const ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const fingerprint =
    opts.fingerprint ?? ((c: Context, key: string) => `${c.req.method} ${c.req.url} ${key}`);

  return async (c, next) => {
    if (!methods.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    const key = c.req.headers.get(header);
    if (!key) {
      await next();
      return;
    }
    const fp = fingerprint(c, key);
    const stored = await store.get(key);
    if (stored) {
      if (stored.fingerprint !== fp) throw new ConflictError("Idempotency key already used");
      const replay = new Response(stored.body as unknown as BodyInit, {
        status: stored.status,
        headers: stored.headers,
      });
      c.setResponse(replay);
      return replay;
    }
    await next();
    const res = c.res;
    if (!res || res.status < 200 || res.status >= 300) return;
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    if (bytes.length > maxBodyBytes) return;
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      headers[name] = value;
    });
    await store.set(key, { status: res.status, headers, body: bytes, fingerprint: fp }, ttlMs);
  };
}
