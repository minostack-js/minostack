# @minostack/jobs

> Background job definitions, scheduler port, and dev-mode worker.

```ts
import { defineJob, MemoryScheduler, Worker } from "@minostack/jobs";

const scheduler = new MemoryScheduler();
const worker = new Worker(scheduler);
worker.register(defineJob("welcome-email", { run: async (ctx) => send(ctx.payload) }));
scheduler.schedule("welcome-email", { to: "ada@example.com" }, { delayMs: 1000 });
await worker.runDue();
```

## Concepts

- `defineJob(name, { run, maxAttempts, backoffMs })` — job contract.
- `Scheduler` / `MemoryScheduler` — `schedule` with `delayMs`, `cancel`.
- `Worker` — `runDue()` executes due jobs, reschedules with doubling backoff.
- `JobContext` — `{ id, name, attempt, payload, traceId?, tenant?, signal }`.
- `fixedClock(t)` / `counterIds()` — deterministic tests, no real timers.

## Dev-mode limitations

- `MemoryScheduler` is single-process and non-durable.
- No queue/cron provider included; `Worker.runDue()` must be driven.
- Backoff doubles per attempt from `backoffMs` (default 1000ms).
