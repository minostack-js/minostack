/**
 * Observability abstractions — TraceContext, Tracer, Span, Instrumentation.
 * Compatible with OpenTelemetry concepts without hard dependency.
 */

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

export interface Span {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly kind: SpanKind;
  setAttribute(key: string, value: string | number | boolean): this;
  addEvent(name: string, attributes?: Record<string, unknown>): this;
  setStatus(status: { code: number; message?: string }): this;
  end(): void;
  isRecording(): boolean;
}

export interface Tracer {
  startSpan(name: string, opts?: { kind?: SpanKind; attributes?: Record<string, unknown> }): Span;
  getCurrentSpan(): Span | undefined;
  withSpan<T>(span: Span, fn: () => T | Promise<T>): Promise<T>;
}

export class NoopSpan implements Span {
  readonly name: string;
  readonly traceId = "0";
  readonly spanId = "0";
  readonly kind: SpanKind = "internal";
  constructor(name: string) {
    this.name = name;
  }
  setAttribute(): this {
    return this;
  }
  addEvent(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  end(): void {}
  isRecording(): boolean {
    return false;
  }
}

export class NoopTracer implements Tracer {
  startSpan(name: string): Span {
    return new NoopSpan(name);
  }
  getCurrentSpan(): Span | undefined {
    return undefined;
  }
  async withSpan<T>(span: Span, fn: () => T | Promise<T>): Promise<T> {
    return await fn();
  }
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

export type Instrumentation = {
  onRequestStart?: (ctx: { request: Request; trace: TraceContext }) => void;
  onRequestEnd?: (ctx: { request: Request; response: Response; duration: number }) => void;
  onError?: (err: unknown, ctx: { request: Request }) => void;
};

/** Global tracer — can be replaced via `setTracer` */
let globalTracer: Tracer = new NoopTracer();

export function getTracer(): Tracer {
  return globalTracer;
}
export function setTracer(tracer: Tracer): void {
  globalTracer = tracer;
}

export function createTraceContext(): TraceContext {
  // Simple random trace id for v0.1; production would use W3C traceparent
  const rand = () => Math.random().toString(36).slice(2, 10);
  return { traceId: rand() + rand(), spanId: rand(), traceFlags: 1 };
}

// ─────────────────────────────────────────────────────────────────
// W3C traceparent propagation (plan P3.5) — `00-<trace-id>-<span-id>-<flags>`
// ─────────────────────────────────────────────────────────────────

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parse an incoming `traceparent` header. Returns `undefined` when absent/malformed. */
export function parseTraceparent(header: string | null | undefined): TraceContext | undefined {
  if (!header) return undefined;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return undefined;
  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return undefined;
  return { traceId, spanId, traceFlags: parseInt(flags, 16) & 1 };
}

/** Serialize a context to a `traceparent` header value. */
export function formatTraceparent(ctx: TraceContext): string {
  const flags = (ctx.traceFlags ?? 1).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Resolve the trace context for a request: continue the incoming trace when
 * the header is valid, otherwise start a fresh one.
 */
export function resolveTraceContext(header: string | null | undefined): TraceContext {
  return parseTraceparent(header) ?? createTraceContext();
}
