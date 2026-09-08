/**
 * Request Context — lazy, stable-shaped, minimal allocations.
 * Per §16: derived values lazily initialized and cached.
 */

import { BadRequestError, PayloadTooLargeError } from "./errors.js";

export type ContextState = Record<string, unknown>;

/**
 * Per-request demand limits (Phase A enterprise hardening).
 * All fields optional overrides; unset fields fall back to DEFAULT_LIMITS.
 * Byte limits are exact (content-length pre-check + streaming byte count).
 */
export interface RequestLimits {
  /** Max JSON body bytes (default 102400). */
  json?: number;
  /** Max text body bytes (default 102400). */
  text?: number;
  /** Max form body bytes (default 102400). */
  form?: number;
  /** Max arrayBuffer body bytes (default 102400). */
  arrayBuffer?: number;
  /** Max distinct query keys (default 100). */
  queryKeys?: number;
  /** Max single query value chars (default 8192). */
  queryValue?: number;
  /** Max header count (default 100). */
  headerKeys?: number;
  /** Max single header value chars (default 8192). */
  headerValue?: number;
  /** Max form fields (default 100). */
  fieldCount?: number;
}

export type ResolvedLimits = Required<RequestLimits>;

export const DEFAULT_LIMITS: ResolvedLimits = {
  json: 102400,
  text: 102400,
  form: 102400,
  arrayBuffer: 102400,
  queryKeys: 100,
  queryValue: 8192,
  headerKeys: 100,
  headerValue: 8192,
  fieldCount: 100,
};

export function resolveLimits(overrides?: RequestLimits): ResolvedLimits {
  if (!overrides) return { ...DEFAULT_LIMITS };
  return { ...DEFAULT_LIMITS, ...overrides };
}

/** Content-length pre-check: reject declared oversize before reading a byte. */
function assertContentLength(req: Request, limit: number): void {
  const cl = req.headers.get("content-length");
  if (cl === null) return;
  const n = Number(cl);
  if (Number.isFinite(n) && n > limit) {
    throw new PayloadTooLargeError(`Body exceeds limit of ${limit} bytes`);
  }
}

/**
 * Read a request body as bytes with a hard cap. Counts streaming chunks so
 * chunked bodies without content-length can't OOM past the limit either.
 */
export async function readLimitedBytes(source: Request, limit: number): Promise<Uint8Array> {
  assertContentLength(source, limit);
  if (source.body === null) return new Uint8Array(0);
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // NOTE: do NOT await reader.cancel() here — on teed clone bodies
        // (validator path) undici's cancel can pend forever. Detaching the
        // reader stops further pulls; the source is GC'd with the request.
        // Socket-level cleanup stays the runtime adapter's job.
        try {
          reader.releaseLock();
        } catch {
          // ignore — the 413 below is what matters
        }
        throw new PayloadTooLargeError(`Body exceeds limit of ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Read a request body as text with a hard byte cap. */
export async function readLimitedText(source: Request, limit: number): Promise<string> {
  const bytes = await readLimitedBytes(source, limit);
  return new TextDecoder().decode(bytes);
}

export class Context<E = Record<string, unknown>, P = Record<string, string>> {
  /** Original Fetch Request */
  readonly req: Request;
  /** Environment bindings (Cloudflare env, etc.) */
  readonly env: E;
  /** Per-request state bag */
  readonly state: ContextState;

  /** Internal cached URL (may be injected by Mino.fetch to avoid double parse) */
  #url?: URL;
  /** Cached query map (single value) */
  #query?: Record<string, string>;
  /** Cached query map (all values) */
  #queryAll?: Record<string, string[]>;
  /** Route params (injected by router) */
  #params: P;
  /** Matched route path */
  #routePath?: string;
  /** Response set by handler chain (for middleware `next` propagation) */
  #response?: Response;
  /** Status override */
  #status?: number;
  /** Header overrides queued before response finalized (lazy: only if headerSet/status used) */
  #headerMap?: Headers;
  /** Resolved demand limits (app defaults merged once at construction). */
  #limits: ResolvedLimits;

  constructor(
    req: Request,
    opts: {
      env?: E;
      params?: P;
      routePath?: string;
      state?: ContextState;
      /** Pre-parsed URL injected by Mino.fetch — avoids 2nd `new URL` per request */
      url?: URL;
      /** Limit overrides from MinoOptions.limits (merged with DEFAULT_LIMITS). */
      limits?: RequestLimits;
    } = {},
  ) {
    this.req = req;
    this.env = opts.env ?? ({} as E);
    this.#params = opts.params ?? ({} as P);
    this.#routePath = opts.routePath;
    this.state = opts.state ?? {};
    if (opts.url) this.#url = opts.url;
    this.#limits = resolveLimits(opts.limits);
  }

  /** Active demand limits for this request. */
  get limits(): ResolvedLimits {
    return this.#limits;
  }

  // ─────────────────────────────────────────────────────────────────
  // Lazy getters
  // ─────────────────────────────────────────────────────────────────

  get url(): URL {
    return (this.#url ??= new URL(this.req.url));
  }

  get path(): string {
    return this.url.pathname;
  }

  get method(): string {
    return this.req.method;
  }

  get routePath(): string | undefined {
    return this.#routePath;
  }

  get params(): P {
    return this.#params;
  }

  /** Set params (called by router after match) */
  setParams(params: P, routePath?: string): void {
    this.#params = params;
    if (routePath) this.#routePath = routePath;
  }

  /** Single param or full map */
  param(): P;
  param<K extends keyof P>(key: K): P[K];
  param(key?: string): unknown {
    if (key === undefined) return this.#params;
    return (this.#params as Record<string, string>)[key];
  }

  /** Query helpers — lazy parsed, bounded by limits (A2). */
  get query(): Record<string, string> {
    if (this.#query) return this.#query;
    const url = this.url;
    const out: Record<string, string> = {};
    let count = 0;
    url.searchParams.forEach((value, key) => {
      if (value.length > this.#limits.queryValue) {
        throw new BadRequestError("Query value too long");
      }
      if (!(key in out)) {
        count++;
        if (count > this.#limits.queryKeys) {
          throw new BadRequestError("Too many query parameters");
        }
        out[key] = value;
      }
    });
    this.#query = out;
    return out;
  }

  get queryAll(): Record<string, string[]> {
    if (this.#queryAll) return this.#queryAll;
    const url = this.url;
    const out: Record<string, string[]> = {};
    let count = 0;
    url.searchParams.forEach((value, key) => {
      if (value.length > this.#limits.queryValue) {
        throw new BadRequestError("Query value too long");
      }
      const arr = out[key];
      if (arr) {
        arr.push(value);
      } else {
        count++;
        if (count > this.#limits.queryKeys) {
          throw new BadRequestError("Too many query parameters");
        }
        out[key] = [value];
      }
    });
    this.#queryAll = out;
    return out;
  }

  queryValue(key: string): string | undefined {
    const v = this.url.searchParams.get(key) ?? undefined;
    if (v !== undefined && v.length > this.#limits.queryValue) {
      throw new BadRequestError("Query value too long");
    }
    return v;
  }

  queries(key: string): string[] {
    const arr = this.url.searchParams.getAll(key);
    if (arr.length > this.#limits.queryKeys) {
      throw new BadRequestError("Too many query parameters");
    }
    for (const v of arr) {
      if (v.length > this.#limits.queryValue) {
        throw new BadRequestError("Query value too long");
      }
    }
    return arr;
  }

  /** Header access — case-insensitive */
  header(name: string): string | undefined {
    return this.req.headers.get(name) ?? undefined;
  }

  get headers(): Headers {
    return this.req.headers;
  }

  // ─────────────────────────────────────────────────────────────────
  // State helpers
  // ─────────────────────────────────────────────────────────────────

  get<K extends string>(key: K): unknown {
    return this.state[key];
  }

  set<K extends string>(key: K, value: unknown): this {
    this.state[key] = value;
    return this;
  }

  var<K extends string>(key: K): unknown {
    return this.state[key];
  }

  // ─────────────────────────────────────────────────────────────────
  // Response helpers
  // ─────────────────────────────────────────────────────────────────

  /**
   * Response currently set on context (after handler/middleware).
   * Used by pipeline to propagate response through `next()`.
   */
  get res(): Response | undefined {
    return this.#response;
  }

  setResponse(res: Response): void {
    this.#response = res;
  }

  status(code: number): this {
    this.#status = code;
    return this;
  }

  headerSet(name: string, value: string): this {
    (this.#headerMap ??= new Headers()).set(name, value);
    return this;
  }

  private finalizeHeaders(init?: ResponseInit): Headers {
    // Fast path: no queued overrides and no status override → reuse init headers directly.
    if (!this.#headerMap) {
      if (!init?.headers) return new Headers();
      return init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    }
    const h = new Headers(init?.headers);
    this.#headerMap.forEach((value, key) => h.set(key, value));
    return h;
  }

  json(data: unknown, status?: number, headers?: HeadersInit): Response {
    const code = status ?? this.#status ?? 200;
    const h = this.finalizeHeaders({ headers });
    if (!h.has("content-type")) h.set("content-type", "application/json; charset=utf-8");
    const res = new Response(JSON.stringify(data), { status: code, headers: h });
    this.#response = res;
    return res;
  }

  text(data: string, status?: number, headers?: HeadersInit): Response {
    const code = status ?? this.#status ?? 200;
    const h = this.finalizeHeaders({ headers });
    if (!h.has("content-type")) h.set("content-type", "text/plain; charset=utf-8");
    const res = new Response(data, { status: code, headers: h });
    this.#response = res;
    return res;
  }

  html(data: string, status?: number, headers?: HeadersInit): Response {
    const code = status ?? this.#status ?? 200;
    const h = this.finalizeHeaders({ headers });
    if (!h.has("content-type")) h.set("content-type", "text/html; charset=utf-8");
    const res = new Response(data, { status: code, headers: h });
    this.#response = res;
    return res;
  }

  redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
    const h = this.finalizeHeaders();
    h.set("location", url);
    const res = new Response(null, { status, headers: h });
    this.#response = res;
    return res;
  }

  /** Return existing response or create new one with body */
  body(data: BodyInit | null, init?: ResponseInit & { headers?: HeadersInit }): Response {
    const code = this.#status ?? init?.status ?? 200;
    const h = this.finalizeHeaders(init);
    const res = new Response(data, { status: code, headers: h });
    this.#response = res;
    return res;
  }

  // ─────────────────────────────────────────────────────────────────
  // Request body helpers — thin wrappers over Request
  // ─────────────────────────────────────────────────────────────────

  async jsonBody<T = unknown>(): Promise<T> {
    // If validator already parsed and cached json, reuse it to avoid bodyUsed error
    // Prefer raw cached JSON (_rawJson) over validated ("json") to preserve raw body semantics
    if (this.#validated) {
      const raw = this.#validated.get("_rawJson");
      if (raw !== undefined) return raw as T;
      const validated = this.#validated.get("json");
      if (validated !== undefined) return validated as T;
    }
    const text = await readLimitedText(this.req, this.#limits.json);
    if (!text) throw new BadRequestError("Invalid JSON body");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new BadRequestError("Invalid JSON body");
    }
  }

  async textBody(): Promise<string> {
    return readLimitedText(this.req, this.#limits.text);
  }

  async arrayBufferBody(): Promise<ArrayBuffer> {
    const bytes = await readLimitedBytes(this.req, this.#limits.arrayBuffer);
    return bytes.buffer as ArrayBuffer;
  }

  async formDataBody(): Promise<FormData> {
    assertContentLength(this.req, this.#limits.form);
    const fd = await this.req.formData();
    let count = 0;
    for (const _ of fd.keys()) {
      count++;
      if (count > this.#limits.fieldCount) {
        throw new PayloadTooLargeError(`Form exceeds limit of ${this.#limits.fieldCount} fields`);
      }
    }
    return fd;
  }

  // ─────────────────────────────────────────────────────────────────
  // Validation integration — stores validated data per `c.req.valid(key)`
  // ─────────────────────────────────────────────────────────────────

  #validated?: Map<string, unknown>;

  setValidated(key: string, value: unknown): void {
    (this.#validated ??= new Map()).set(key, value);
  }

  valid<T = unknown>(key: string): T {
    return this.#validated?.get(key) as T;
  }

  // ─────────────────────────────────────────────────────────────────
  // SSE helper — returns an event-stream Response
  // ─────────────────────────────────────────────────────────────────

  sse(
    stream: ReadableStream<string> | AsyncIterable<string>,
    init: { headers?: HeadersInit } = {},
  ): Response {
    let readable: ReadableStream<string>;
    if (stream instanceof ReadableStream) {
      readable = stream as ReadableStream<string>;
    } else {
      const iterable = stream as AsyncIterable<string>;
      readable = new ReadableStream<string>({
        async start(controller) {
          try {
            for await (const chunk of iterable) controller.enqueue(chunk);
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        },
      });
    }
    // Encode strings to Uint8Array if needed
    const encoded = readable.pipeThrough(
      new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(new TextEncoder().encode(chunk));
        },
      }),
    );
    const h = this.finalizeHeaders(init);
    h.set("content-type", "text/event-stream");
    h.set("cache-control", "no-cache");
    h.set("connection", "keep-alive");
    const res = new Response(encoded as unknown as BodyInit, { headers: h });
    this.#response = res;
    return res;
  }
}
