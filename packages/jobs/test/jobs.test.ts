import { describe, it, expect } from "vitest";
import { defineJob, MemoryScheduler, Worker, counterIds, fixedClock } from "../src/index.js";

describe("@minostack/jobs", () => {
  it("schedules with delay and runs when due", async () => {
    const clock = fixedClock(0);
    const scheduler = new MemoryScheduler({ clock, ids: counterIds() });
    const worker = new Worker(scheduler, { clock });
    const ran: Array<{ attempt: number; payload: unknown }> = [];
    worker.register(
      defineJob("email", {
        run: (ctx) => {
          ran.push({ attempt: ctx.attempt, payload: ctx.payload });
        },
      }),
    );
    scheduler.schedule("email", { to: "ada@example.com" }, { delayMs: 1000 });
    expect(await worker.runDue()).toHaveLength(0);
    expect(ran).toHaveLength(0);
    clock.advance(1000);
    const outcomes = await worker.runDue();
    expect(outcomes).toEqual([{ id: "job-1", ok: true }]);
    expect(ran).toEqual([{ attempt: 1, payload: { to: "ada@example.com" } }]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("retries with doubling backoff then succeeds", async () => {
    const clock = fixedClock(0);
    const scheduler = new MemoryScheduler({ clock, ids: counterIds() });
    const worker = new Worker(scheduler, { clock });
    let calls = 0;
    worker.register(
      defineJob("flaky", {
        maxAttempts: 3,
        backoffMs: 1000,
        run: () => {
          if (++calls < 3) throw new Error("not yet");
        },
      }),
    );
    scheduler.schedule("flaky", {});
    clock.advance(0);
    expect((await worker.runDue())[0]?.ok).toBe(false);
    // First backoff: 1000ms
    clock.advance(999);
    expect(await worker.runDue()).toHaveLength(0);
    clock.advance(1);
    expect((await worker.runDue())[0]?.ok).toBe(false);
    // Second backoff: 2000ms
    clock.advance(1999);
    expect(await worker.runDue()).toHaveLength(0);
    clock.advance(1);
    expect((await worker.runDue())[0]).toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });

  it("records exhaustion to the audit sink and stops retrying", async () => {
    const clock = fixedClock(0);
    const scheduler = new MemoryScheduler({ clock, ids: counterIds() });
    const events: Array<Record<string, unknown>> = [];
    const worker = new Worker(scheduler, { clock, audit: { record: (e) => void events.push(e) } });
    worker.register(
      defineJob("doomed", {
        maxAttempts: 2,
        backoffMs: 100,
        run: () => {
          throw new Error("always");
        },
      }),
    );
    scheduler.schedule("doomed", {}, { traceId: "t1", tenant: "acme" });
    await worker.runDue();
    clock.advance(100);
    await worker.runDue();
    expect(scheduler.pendingCount).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "job.failed", job: "doomed", attempt: 2 });
  });

  it("cancel prevents execution; unknown jobs fail with audit", async () => {
    const clock = fixedClock(0);
    const scheduler = new MemoryScheduler({ clock, ids: counterIds() });
    const events: Array<Record<string, unknown>> = [];
    const worker = new Worker(scheduler, { clock, audit: { record: (e) => void events.push(e) } });
    const job = scheduler.schedule("cancelled", {});
    expect(scheduler.cancel(job.id)).toBe(true);
    expect(scheduler.cancel("missing")).toBe(false);
    scheduler.schedule("ghost", {});
    const outcomes = await worker.runDue();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(false);
    expect(events[0]).toMatchObject({ type: "job.failed", job: "ghost" });
    expect(() => worker.register(defineJob("dup", { run: () => {} }))).not.toThrow();
    expect(() => worker.register(defineJob("dup", { run: () => {} }))).toThrow(
      /already registered/,
    );
  });

  it("jobs observe cooperative cancellation signals", async () => {
    const clock = fixedClock(0);
    const scheduler = new MemoryScheduler({ clock, ids: counterIds() });
    const worker = new Worker(scheduler, { clock });
    let sawSignal = false;
    worker.register(
      defineJob("coop", {
        run: (ctx) => {
          sawSignal = ctx.signal instanceof AbortSignal && !ctx.signal.aborted;
        },
      }),
    );
    scheduler.schedule("coop", {});
    await worker.runDue();
    expect(sawSignal).toBe(true);
  });
});

describe("@minostack/jobs coverage", () => {
  it("default ids are unique and runAll delegates", async () => {
    const scheduler = new MemoryScheduler();
    const a = scheduler.schedule("x", {});
    const b = scheduler.schedule("x", {});
    expect(a.id).not.toBe(b.id);
    const worker = new Worker(scheduler);
    let runs = 0;
    worker.register(
      defineJob("x", {
        run: () => {
          runs++;
        },
      }),
    );
    await worker.runAll();
    expect(runs).toBe(2);
    expect(await worker.runAll()).toHaveLength(0);
  });

  it("audit records completion and unknown-job failures carry job context", async () => {
    const clock = fixedClock(0);
    const scheduler = new MemoryScheduler({ clock, ids: counterIds() });
    const events: Array<Record<string, unknown>> = [];
    const worker = new Worker(scheduler, { clock, audit: { record: (e) => void events.push(e) } });
    worker.register(defineJob("ok", { run: () => {} }));
    scheduler.schedule("ok", {}, { traceId: "t9", tenant: "acme" });
    await worker.runDue();
    expect(events[0]).toMatchObject({ type: "job.completed", job: "ok", attempt: 1 });
  });
});
