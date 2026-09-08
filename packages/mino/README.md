# @minostack/mino

> Lightweight, Fetch-native, runtime-agnostic HTTP framework for Minostack.

```ts
import { Mino } from "@minostack/mino";

const app = new Mino();

app.get("/", (c) => c.json({ ok: true }));
app.get("/users/:id", (c) => c.json({ id: c.param("id") }));

export default app; // `app.fetch` is a Fetch handler
```

## Features

- **Fetch-native** — `Request`/`Response`/`Headers`/`ReadableStream`/`URL`/`AbortSignal`. No Express/Hono dependency.
- **Router** — radix-inspired, static > param > wildcard priority, `c.params` extraction.
- **Context** — lazy `c.url`, `c.query`, `c.params`, `c.headers`, `c.state`, helpers `c.json`/`c.text`/`c.html`/`c.redirect`/`c.sse`.
- **Middleware** — precompiled pipeline (`compose`), `app.use`, path-scoped `app.use("/api", mw)`, `await next()` semantics.
- **Validation** — `validator("json", schema)` via **any Standard Schema** — `@minostack/schema`, Zod, Valibot, ArkType, etc. Zero runtime dep on schema lib (duck-typed `AnySchema` with `~standard` → `safeParse` → `parse` fallback).
- **SSE / WebSocket** — `c.sse(stream)` and streaming `Response` support.
- **Client** — `createClient("http://localhost")` RPC-like typed proxy (`client.users[":id"].$get({ param: { id } })`).
- **Contract-first** — `defineRoute`, `describeRoute`, `dto`, shared with `@minostack/openapi` & `@minostack/graphql`.

## Quickstart

```ts
// Node — zero other deps required
import { Mino } from "@minostack/mino";
import { serve } from "@minostack/runtime-node";

const app = new Mino();
app.get("/", (c) => c.text("hello"));

serve(app, { port: 3000 });

// Fetch handler (Bun/Deno/Workers)
export default { fetch: app.fetch };
```

## Validation — any Standard Schema

```ts
import { Mino } from "@minostack/mino";
import { validator } from "@minostack/mino";
import { m } from "@minostack/schema"; // or Zod, Valibot, ArkType…
import { z } from "zod";
import * as v from "valibot";

const app = new Mino();

// Minostack schema
const UserMino = m.object({ name: m.string().min(2) });
app.post("/mino", validator("json", UserMino), (c) => c.json(c.valid("json")));

// Zod — works because Zod implements ~standard
const UserZod = z.object({ name: z.string().min(2) });
app.post("/zod", validator("json", UserZod), (c) => c.json(c.valid("json")));

// Valibot — same
const UserValibot = v.object({ name: v.pipe(v.string(), v.minLength(2)) });
app.post("/valibot", validator("json", UserValibot), (c) => c.json(c.valid("json")));

// Any library with safeParse/parse also works (fallback order: ~standard → safeParse → parse)
```

No `peerDependencies` — install only what you use. `npm i @minostack/mino` alone is a complete HTTP framework.

## Runtime adapters (separate packages)

- `@minostack/runtime-node` — `serve(app, { port })`, `toRequest`/`toNodeResponse`
- `@minostack/runtime-bun` — `serve(app, { port })` via `Bun.serve`
- `@minostack/runtime-deno` — `serve(app, { port })` via `Deno.serve`

## Performance philosophy

- Low allocations on the request path (lazy `Context`, pre-split paths)
- No per-request regex or temporary arrays (future compressed radix optimization)
- Benchmark harness in `apps/benchmark` — see prompt §31-32 for metrics.

See `AGENTS.md` and `prompt.md` for architecture.
