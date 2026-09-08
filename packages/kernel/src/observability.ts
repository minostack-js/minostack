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
