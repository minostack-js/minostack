# @minostack/events

> Schema-backed domain events, outbox port, and dev-mode bus.

```ts
import { m } from "@minostack/schema";
import { defineEvent, createEnvelope, MemoryEventBus } from "@minostack/events";

const UserCreated = defineEvent("user.created", m.object({ id: m.string() }));
const bus = new MemoryEventBus();
bus.subscribe("user.created", async (e) => console.log(e.payload));
await bus.publish(createEnvelope(UserCreated, { id: "1" }));
```

## Concepts

- `defineEvent(name, schema)` — canonical event contract.
- `createEnvelope(def, payload, { traceId, tenant, actor })` — validated envelope.
- `MemoryEventBus` — pub/sub with inline retry and `deadLetter` capture.
- `Outbox` / `MemoryOutbox` — `append` → `claim` → `ack`/`nack` relay cycle.
- `counterIds()` / `fixedClock(t)` — deterministic tests.

## Dev-mode limitations

- No broker integration (Kafka/Redis/RabbitMQ stay outside core).
- `MemoryEventBus` retries inline; no delayed redelivery or persistence.
- `MemoryOutbox` is single-process and non-durable.
