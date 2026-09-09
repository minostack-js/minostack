/**
 * @minostack/events — schema-backed domain events, outbox port, dev bus.
 *
 * Dev-mode preview. IDs and clocks are injectable for deterministic tests.
 *
 * ```ts
 * import { m } from "@minostack/schema";
 * import { defineEvent, createEnvelope, MemoryEventBus } from "@minostack/events";
 *
 * const UserCreated = defineEvent("user.created", m.object({ id: m.string() }));
 * const bus = new MemoryEventBus();
 * bus.subscribe("user.created", async (e) => console.log(e.payload));
 * await bus.publish(createEnvelope(UserCreated, { id: "1" }));
 * ```
 */

export type AnySchema = {
  readonly "~standard"?: {
    readonly validate: (value: unknown) => { value: unknown } | { issues: readonly unknown[] };
  };
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: readonly unknown[] };
  };
  parse?: (value: unknown) => unknown;
} & object;

export interface EventDefinition<T = unknown> {
  readonly name: string;
  readonly schema: AnySchema;
  readonly _type?: T;
}

/** Declare a named, schema-backed domain event. */
export function defineEvent<T>(name: string, schema: AnySchema): EventDefinition<T> {
  return { name, schema };
}

export interface EventEnvelope<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly occurredAt: string;
  readonly payload: T;
  readonly traceId?: string;
  readonly tenant?: string;
  readonly actor?: string;
}

export interface EnvelopeContext {
  traceId?: string;
  tenant?: string;
  actor?: string;
  id?: string;
  at?: string;
}

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  next(): string;
}

const defaultClock: Clock = { now: () => Date.now() };

function defaultId(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${rand()}-${rand()}`;
}

/** Deterministic id generator for tests. */
export function counterIds(prefix = "evt"): IdGenerator {
  let n = 0;
  return { next: () => `${prefix}-${++n}` };
}

/** Fixed clock for tests. */
export function fixedClock(at: number): Clock & { advance(ms: number): void } {
  let t = at;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function validatePayload(
  schema: AnySchema,
  value: unknown,
): { success: true; data: unknown } | { success: false; issues: readonly unknown[] } {
  const std = schema["~standard"];
  if (std) {
    const res = std.validate(value) as { value: unknown } | { issues: readonly unknown[] };
    if ("value" in res) return { success: true, data: res.value };
    return { success: false, issues: [...(res.issues ?? [])] };
  }
  if (typeof schema.safeParse === "function") {
    const res = schema.safeParse(value);
    if (res.success) return { success: true, data: res.data };
    return { success: false, issues: [...(res.error?.issues ?? [])] };
  }
  if (typeof schema.parse === "function") {
    try {
      return { success: true, data: schema.parse(value) };
    } catch (e: unknown) {
      return {
        success: false,
        issues: [{ message: e instanceof Error ? e.message : "Validation failed" }],
      };
    }
  }
  throw new Error("Invalid schema: missing ~standard/safeParse/parse");
}

export class EventValidationError extends Error {
  readonly issues: readonly unknown[];
  constructor(name: string, issues: readonly unknown[]) {
    super(`Invalid payload for event "${name}"`);
    this.name = "EventValidationError";
    this.issues = issues;
  }
}

export interface EnvelopeOptions {
  clock?: Clock;
  ids?: IdGenerator;
}

/** Validate the payload and wrap it in a trace-correlated envelope. */
export function createEnvelope<T>(
  def: EventDefinition<T>,
  payload: unknown,
  ctx: EnvelopeContext = {},
  opts: EnvelopeOptions = {},
): EventEnvelope<T> {
  const res = validatePayload(def.schema, payload);
  if (!res.success) throw new EventValidationError(def.name, res.issues);
  const at = (opts.clock ?? defaultClock).now();
  const envelope: EventEnvelope<T> = {
    id: ctx.id ?? opts.ids?.next() ?? defaultId(),
    name: def.name,
    occurredAt: new Date(at).toISOString(),
    payload: res.data as T,
  };
  if (ctx.traceId !== undefined) (envelope as { traceId?: string }).traceId = ctx.traceId;
  if (ctx.tenant !== undefined) (envelope as { tenant?: string }).tenant = ctx.tenant;
  if (ctx.actor !== undefined) (envelope as { actor?: string }).actor = ctx.actor;
  return envelope;
}

/** Structural guard for envelopes crossing boundaries. */
export function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.occurredAt === "string" &&
    "payload" in v
  );
}

export interface EventPublisher {
  publish(envelope: EventEnvelope): void | Promise<void>;
}

export type EventHandler = (envelope: EventEnvelope) => void | Promise<void>;

export interface BusOptions {
  /** Attempts before an envelope moves to `deadLetter` (default 3) */
  maxAttempts?: number;
}

/**
 * In-memory bus for dev/tests. Failed handlers retry inline up to
 * `maxAttempts`, then the envelope lands in `deadLetter` with the last error.
 */
export class MemoryEventBus implements EventPublisher {
  private handlers = new Map<string, EventHandler[]>();
  readonly deadLetter: Array<{ envelope: EventEnvelope; error: unknown; attempts: number }> = [];
  private readonly maxAttempts: number;

  constructor(opts: BusOptions = {}) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  }

  subscribe(name: string, handler: EventHandler): () => void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
    return () => {
      const cur = this.handlers.get(name) ?? [];
      this.handlers.set(
        name,
        cur.filter((h) => h !== handler),
      );
    };
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    const list = this.handlers.get(envelope.name) ?? [];
    for (const handler of list) {
      let attempts = 0;
      for (;;) {
        attempts++;
        try {
          await handler(envelope);
          break;
        } catch (error) {
          if (attempts >= this.maxAttempts) {
            this.deadLetter.push({ envelope, error, attempts });
            break;
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Outbox port — transactional staging for publishers (P5.2)
// ─────────────────────────────────────────────────────────────────

export interface OutboxRecord {
  readonly id: string;
  readonly envelope: EventEnvelope;
}

export interface Outbox {
  append(envelope: EventEnvelope): void | Promise<void>;
  claim(limit?: number): OutboxRecord[] | Promise<OutboxRecord[]>;
  ack(id: string): void | Promise<void>;
  nack(id: string): void | Promise<void>;
}

/** In-memory outbox: claimed records hide until acked or nacked. */
export class MemoryOutbox implements Outbox {
  private pending: OutboxRecord[] = [];
  private claimed = new Map<string, OutboxRecord>();
  private readonly ids: IdGenerator;

  constructor(opts: { ids?: IdGenerator } = {}) {
    this.ids = opts.ids ?? { next: defaultId };
  }

  append(envelope: EventEnvelope): void {
    this.pending.push({ id: this.ids.next(), envelope });
  }

  claim(limit = 10): OutboxRecord[] {
    const batch = this.pending.splice(0, Math.max(1, limit));
    for (const r of batch) this.claimed.set(r.id, r);
    return batch;
  }

  ack(id: string): void {
    this.claimed.delete(id);
  }

  nack(id: string): void {
    const rec = this.claimed.get(id);
    if (rec) {
      this.claimed.delete(id);
      this.pending.unshift(rec);
    }
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
