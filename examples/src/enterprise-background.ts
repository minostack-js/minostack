/**
 * Enterprise: background job plus audit trail (dev-mode preview).
 *
 * A `user.created` event fans out to a welcome-email job; the worker records
 * outcomes to an in-memory audit sink. Deterministic: no real timers.
 *
 * Expected: scheduling the event runs the job and records `job.completed`.
 */

import { MemoryEventBus, defineEvent, createEnvelope } from "@minostack/events";
import { MemoryScheduler, Worker, defineJob, fixedClock } from "@minostack/jobs";
import { m } from "@minostack/schema";

export const UserCreated = defineEvent<{ id: string; email: string }>(
  "user.created",
  m.object({ id: m.string(), email: m.string().email() }),
);

export const auditEvents: Array<Record<string, unknown>> = [];
export const sentEmails: string[] = [];

export const clock = fixedClock(Date.parse("2026-09-09T00:00:00.000Z"));
export const scheduler = new MemoryScheduler({ clock });
export const worker = new Worker(scheduler, {
  clock,
  audit: { record: (e) => void auditEvents.push(e) },
});

worker.register(
  defineJob<{ email: string }>("welcome-email", {
    maxAttempts: 3,
    backoffMs: 1000,
    run: (ctx) => {
      sentEmails.push(ctx.payload.email);
    },
  }),
);

export const bus = new MemoryEventBus();
bus.subscribe("user.created", (envelope) => {
  const payload = envelope.payload as { email: string };
  scheduler.schedule("welcome-email", { email: payload.email }, { traceId: envelope.traceId });
});

export async function signup(id: string, email: string): Promise<void> {
  await bus.publish(createEnvelope(UserCreated, { id, email }, { traceId: "trace-1" }));
  await worker.runDue();
}
