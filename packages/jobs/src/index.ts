/**
 * @minostack/jobs — job definitions, scheduler port, dev-mode worker.
 *
 * Dev-mode preview. Time is injectable; `MemoryScheduler` runs due jobs only
 * when `runDue()`/`runAll()` is called, so tests never wait on real timers.
 * Outcomes can be recorded to any structurally-typed audit sink.
 *
 * ```ts
 * import { defineJob, MemoryScheduler, Worker } from "@minostack/jobs";
 *
 * const scheduler = new MemoryScheduler();
 * const worker = new Worker(scheduler, { clock });
 * worker.register(defineJob("welcome-email", { run: async (ctx) => send(ctx.payload) }));
 * scheduler.schedule("welcome-email", { to: "ada@example.com" }, { delayMs: 1000 });
 * await worker.runDue();
 * ```
 */

export interface Clock {
  now(): number;
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

/** Deterministic id generator for tests. */
export function counterIds(prefix = "job"): { next(): string } {
  let n = 0;
  return { next: () => `${prefix}-${++n}` };
}

export interface JobContext<P = unknown> {
  readonly id: string;
  readonly name: string;
  /** 1-based attempt number */
  readonly attempt: number;
  readonly payload: P;
  readonly traceId?: string;
  readonly tenant?: string;
  /** Cooperative cancellation — jobs should observe `signal.aborted` */
  readonly signal: AbortSignal;
}

export interface JobDefinition<P = unknown> {
  readonly name: string;
  readonly run: (ctx: JobContext<P>) => void | Promise<void>;
  /** Max attempts including the first (default 1 = no retry) */
  readonly maxAttempts?: number;
  /** Base backoff between attempts in ms (doubles per attempt, default 1000) */
  readonly backoffMs?: number;
}

/** Declare a named background job. */
export function defineJob<P>(name: string, opts: Omit<JobDefinition<P>, "name">): JobDefinition<P> {
  return { name, ...opts };
}

export interface ScheduledJob<P = unknown> {
  readonly id: string;
  readonly name: string;
  readonly payload: P;
  readonly traceId?: string;
  readonly tenant?: string;
  /** Attempt the job is scheduled for (starts at 1) */
  attempt: number;
  /** Epoch ms when the job becomes due */
  dueAt: number;
  cancelled?: boolean;
}

export interface Scheduler {
  schedule<P>(
    name: string,
    payload: P,
    opts?: { delayMs?: number; traceId?: string; tenant?: string; attempt?: number },
  ): ScheduledJob<P>;
  cancel(id: string): boolean;
}

/**
 * In-memory scheduler. `dueAt` derives from the injected clock; nothing runs
 * on its own — the `Worker` pulls due jobs via `takeDue()`.
 */
export class MemoryScheduler implements Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly now: () => number;
  private readonly nextId: () => string;

  constructor(opts: { clock?: Clock; ids?: { next(): string } } = {}) {
    this.now = opts.clock?.now ?? Date.now;
    const n = { count: 0 };
    this.nextId =
      opts.ids?.next ??
      (() => {
        n.count++;
        return `job-${Date.now()}-${n.count}-${Math.random().toString(36).slice(2, 8)}`;
      });
  }

  schedule<P>(
    name: string,
    payload: P,
    opts: { delayMs?: number; traceId?: string; tenant?: string; attempt?: number } = {},
  ): ScheduledJob<P> {
    const job: ScheduledJob<P> = {
      id: this.nextId(),
      name,
      payload,
      attempt: opts.attempt ?? 1,
      dueAt: this.now() + (opts.delayMs ?? 0),
    };
    if (opts.traceId !== undefined) (job as { traceId?: string }).traceId = opts.traceId;
    if (opts.tenant !== undefined) (job as { tenant?: string }).tenant = opts.tenant;
    this.jobs.set(job.id, job as ScheduledJob);
    return job;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.cancelled = true;
    this.jobs.delete(id);
    return true;
  }

  /** Remove and return jobs due at `at` (default: now). */
  takeDue(at?: number): ScheduledJob[] {
    const t = at ?? this.now();
    const due: ScheduledJob[] = [];
    for (const job of this.jobs.values()) {
      if (!job.cancelled && job.dueAt <= t) {
        due.push(job);
        this.jobs.delete(job.id);
      }
    }
    return due;
  }

  get pendingCount(): number {
    return this.jobs.size;
  }
}

export interface AuditSink {
  record(event: Record<string, unknown>): void | Promise<void>;
}

export interface WorkerOptions {
  clock?: Clock;
  audit?: AuditSink;
  ids?: { next(): string };
}

/**
 * Dev-mode worker: executes due jobs, reschedules failures with doubling
 * backoff, and records `job.completed` / `job.failed` outcomes to the audit
 * sink when one is provided. Each attempt gets its own AbortSignal.
 */
export class Worker {
  private readonly defs = new Map<string, JobDefinition>();
  private readonly scheduler: MemoryScheduler;
  private readonly now: () => number;
  private readonly audit?: AuditSink;

  constructor(scheduler: MemoryScheduler, opts: WorkerOptions = {}) {
    this.scheduler = scheduler;
    this.now = opts.clock?.now ?? Date.now;
    this.audit = opts.audit;
  }

  register<P>(def: JobDefinition<P>): this {
    if (this.defs.has(def.name)) throw new Error(`Job "${def.name}" already registered`);
    this.defs.set(def.name, def as JobDefinition<unknown>);
    return this;
  }

  /** Execute all jobs due now. Returns per-job outcomes. */
  async runDue(): Promise<Array<{ id: string; ok: boolean; error?: unknown }>> {
    const outcomes: Array<{ id: string; ok: boolean; error?: unknown }> = [];
    for (const job of this.scheduler.takeDue(this.now())) {
      outcomes.push(await this.execute(job));
    }
    return outcomes;
  }

  /** Advance `ms` on fixed clocks then run due — convenience for tests. */
  async runAll(): Promise<Array<{ id: string; ok: boolean; error?: unknown }>> {
    return this.runDue();
  }

  private async execute(job: ScheduledJob): Promise<{ id: string; ok: boolean; error?: unknown }> {
    const def = this.defs.get(job.name);
    if (!def) {
      const error = new Error(`Unknown job "${job.name}"`);
      await this.audit?.record({
        type: "job.failed",
        job: job.name,
        id: job.id,
        error: String(error),
      });
      return { id: job.id, ok: false, error };
    }
    const maxAttempts = Math.max(1, def.maxAttempts ?? 1);
    const controller = new AbortController();
    const ctx: JobContext = {
      id: job.id,
      name: job.name,
      attempt: job.attempt,
      payload: job.payload,
      signal: controller.signal,
    };
    if (job.traceId !== undefined) (ctx as { traceId?: string }).traceId = job.traceId;
    if (job.tenant !== undefined) (ctx as { tenant?: string }).tenant = job.tenant;
    try {
      await def.run(ctx);
      await this.audit?.record({
        type: "job.completed",
        job: job.name,
        id: job.id,
        attempt: job.attempt,
      });
      return { id: job.id, ok: true };
    } catch (error) {
      if (job.attempt < maxAttempts) {
        const backoff = (def.backoffMs ?? 1000) * 2 ** (job.attempt - 1);
        this.scheduler.schedule(job.name, job.payload, {
          delayMs: backoff,
          attempt: job.attempt + 1,
          traceId: job.traceId,
          tenant: job.tenant,
        });
        return { id: job.id, ok: false, error };
      }
      await this.audit?.record({
        type: "job.failed",
        job: job.name,
        id: job.id,
        attempt: job.attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      return { id: job.id, ok: false, error };
    }
  }
}
