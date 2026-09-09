import { describe, it, expect } from "vitest";
import { m } from "@minostack/schema";
import {
  defineEvent,
  createEnvelope,
  isEventEnvelope,
  EventValidationError,
  MemoryEventBus,
  MemoryOutbox,
  counterIds,
  fixedClock,
} from "../src/index.js";

const UserCreated = defineEvent<{ id: string }>("user.created", m.object({ id: m.string() }));

describe("@minostack/events", () => {
  it("creates validated, correlated envelopes", () => {
    const ids = counterIds();
    const clock = fixedClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const e = createEnvelope(
      UserCreated,
      { id: "1" },
      { traceId: "t1", tenant: "acme", actor: "ada" },
      { clock, ids },
    );
    expect(e).toMatchObject({
      id: "evt-1",
      name: "user.created",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { id: "1" },
      traceId: "t1",
      tenant: "acme",
      actor: "ada",
    });
    expect(isEventEnvelope(e)).toBe(true);
    expect(isEventEnvelope({ nope: true })).toBe(false);
  });

  it("rejects invalid payloads without leaking internals", () => {
    expect(() => createEnvelope(UserCreated, { id: 42 })).toThrow(EventValidationError);
    try {
      createEnvelope(UserCreated, { id: 42 });
    } catch (e) {
      expect((e as Error).message).toBe('Invalid payload for event "user.created"');
    }
  });

  it("bus delivers, retries, then dead-letters", async () => {
    const bus = new MemoryEventBus({ maxAttempts: 2 });
    const seen: string[] = [];
    let failures = 0;
    bus.subscribe("user.created", (e) => {
      seen.push((e.payload as { id: string }).id);
    });
    bus.subscribe("user.created", () => {
      failures++;
      throw new Error("downstream down");
    });
    await bus.publish(createEnvelope(UserCreated, { id: "7" }, {}, { ids: counterIds() }));
    expect(seen).toEqual(["7"]);
    expect(failures).toBe(2);
    expect(bus.deadLetter).toHaveLength(1);
    expect(bus.deadLetter[0]?.attempts).toBe(2);
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new MemoryEventBus();
    let n = 0;
    const off = bus.subscribe("user.created", () => {
      n++;
    });
    await bus.publish(createEnvelope(UserCreated, { id: "1" }, {}, { ids: counterIds() }));
    off();
    await bus.publish(createEnvelope(UserCreated, { id: "2" }, {}, { ids: counterIds() }));
    expect(n).toBe(1);
  });

  it("outbox claim/ack/nack cycle", () => {
    const outbox = new MemoryOutbox({ ids: counterIds("rec") });
    outbox.append(createEnvelope(UserCreated, { id: "a" }, {}, { ids: counterIds() }));
    outbox.append(createEnvelope(UserCreated, { id: "b" }, {}, { ids: counterIds() }));
    const batch = outbox.claim(1);
    expect(batch).toHaveLength(1);
    expect(outbox.pendingCount).toBe(1);
    outbox.nack(batch[0]?.id as string);
    expect(outbox.pendingCount).toBe(2);
    const batch2 = outbox.claim(10);
    expect(batch2).toHaveLength(2);
    for (const r of batch2) outbox.ack(r.id);
    expect(outbox.pendingCount).toBe(0);
    outbox.ack("missing");
    outbox.nack("missing");
  });
});

describe("@minostack/events coverage", () => {
  it("defaults clock and ids when not injected", () => {
    const e = createEnvelope(UserCreated, { id: "z" });
    expect(e.id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(Date.parse(e.occurredAt)).not.toBeNaN();
    expect(e).not.toHaveProperty("traceId");
  });

  it("honors explicit envelope id/at", () => {
    const e = createEnvelope(
      UserCreated,
      { id: "z" },
      { id: "custom", at: "2026-05-05T00:00:00.000Z" },
    );
    expect(e.id).toBe("custom");
  });

  it("supports safeParse/parse-throw/invalid schemas", () => {
    const sp = defineEvent("sp", {
      safeParse: (v: unknown) => ({ success: true as const, data: v }),
    });
    expect(createEnvelope(sp, { a: 1 }).payload).toEqual({ a: 1 });
    const spBad = defineEvent("spb", {
      safeParse: () => ({ success: false as const, error: { issues: [] } }),
    });
    expect(() => createEnvelope(spBad, {})).toThrow(EventValidationError);
    const pt = defineEvent("pt", {
      parse: () => {
        throw new Error("bad payload");
      },
    });
    try {
      createEnvelope(pt, {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EventValidationError);
      expect((e as EventValidationError).issues).toEqual([{ message: "bad payload" }]);
    }
    const ptStr = defineEvent("pts", {
      parse: () => {
        throw "string-fail";
      },
    });
    expect(() => createEnvelope(ptStr, {})).toThrow(EventValidationError);
    expect(() => createEnvelope(defineEvent("inv", {}), {})).toThrow(/missing ~standard/);
  });

  it("fixedClock advances and custom id prefixes work", () => {
    const clock = fixedClock(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    expect(counterIds("job").next()).toBe("job-1");
    expect(isEventEnvelope(null)).toBe(false);
    expect(isEventEnvelope("x")).toBe(false);
    expect(isEventEnvelope({ id: "a", name: "b", occurredAt: 1, payload: {} })).toBe(false);
  });
});
