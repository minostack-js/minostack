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
- **Validation** — `validator("json", schema)` via **any Standard Schema** — `@minostack/schema`, Zod, Valibot, ArkType, etc. Zero runtime dep on schema lib (duck-typed `AnySchema` with `~standard` → `safeParse` → `parse` fallback). Async schemas via `validatorAsync(...)` (sync path stays zero-overhead).
- **Sub-paths** — opt-in, zero core weight: `helmet` `cors` `rate-limit` `timeout` `request-id` `cookie` `jwt` `paseto` `csrf` `session` `compress` `etag` `static` `basic-auth` `bearer-auth` `method-override` `trailing-slash` `trim-path` `vhost` `response-time` `powered-by` `ip-restriction` `formbody` `cache` `proxy` `under-pressure` `websocket` `file` `logger` `multipart` `envelope` `principal` `oidc` `retry` `circuit-breaker` `bulkhead` `idempotency` `health` `versioning` — import `@minostack/mino/<name>` only for what you use.
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

## Sub-paths

```ts
import { helmet } from "@minostack/mino/helmet";
import { cors } from "@minostack/mino/cors";
import { rateLimit } from "@minostack/mino/rate-limit";
import { getCookie, setCookie } from "@minostack/mino/cookie";
import { jwt } from "@minostack/mino/jwt"; // HS256/RS256/ES256 via SubtleCrypto
import { token } from "@minostack/mino/jwt"; // switchable: JWT or PASETO (auto by v4. prefix)
import { paseto } from "@minostack/mino/paseto"; // PASETO v4.local + v4.public
import { csrf } from "@minostack/mino/csrf"; // double-submit + Origin check
import { session } from "@minostack/mino/session"; // MemoryStore + Store iface
import { compress } from "@minostack/mino/compress"; // gzip/deflate
import { etag } from "@minostack/mino/etag";
import { serveStatic } from "@minostack/mino/static"; // loader iface
import { createNodeLoader } from "@minostack/runtime-node"; // or createBunLoader / createDenoLoader
import { basic } from "@minostack/mino/basic-auth";
import { bearer } from "@minostack/mino/bearer-auth";
import { withMethodOverride } from "@minostack/mino/method-override"; // fetch-level (pre-routing)
import { trailingSlash } from "@minostack/mino/trailing-slash";
import { trimPath } from "@minostack/mino/trim-path";
import { vhost } from "@minostack/mino/vhost";
import { combine } from "@minostack/mino/proxy";
import { responseTime } from "@minostack/mino/response-time";
import { poweredBy } from "@minostack/mino/powered-by";
import { ipRestrict } from "@minostack/mino/ip-restriction";
import { formbody } from "@minostack/mino/formbody";
import { cache } from "@minostack/mino/cache";
import { proxy } from "@minostack/mino/proxy";
import { underPressure } from "@minostack/mino/under-pressure";
import { isWebSocketRequest } from "@minostack/mino/websocket";
import { contentDisposition } from "@minostack/mino/file"; // + c.file() on Context, Range/206 in static
import { logger } from "@minostack/mino/logger"; // also re-exported from mino/request-id
import { parseMultipart } from "@minostack/mino/multipart"; // streaming uploads (see runtime pipeToFile)
import { ok, page } from "@minostack/mino/envelope"; // optional success/error/page envelopes
import { attachPrincipal, requireRole } from "@minostack/mino/principal"; // shared identity + RBAC + audit
import { authorizationUrl, pollDeviceToken } from "@minostack/mino/oidc"; // OIDC: code/PKCE, client-creds, device flow
import { withRetry } from "@minostack/mino/retry"; // bounded retry with budgets
import { CircuitBreaker } from "@minostack/mino/circuit-breaker"; // fail-fast short-circuit
import { bulkhead } from "@minostack/mino/bulkhead"; // concurrency isolation (429 on saturation)
import { idempotency } from "@minostack/mino/idempotency"; // idempotency-key replay for unsafe methods
import { live, ready } from "@minostack/mino/health"; // liveness/readiness with dependency checks
import { versioned, sunset } from "@minostack/mino/versioning"; // /v1 + /v2 coexistence, Sunset headers
```

Files and ranges: `serveStatic` answers single-range `Range` requests with `206` (+ `Accept-Ranges`), multi-range with `206 multipart/byteranges`, honors `If-Range` (`304` still wins), streams file bodies from the runtime loaders (no full-file buffering), and `validator("octet-stream", schema)` validates bounded raw bytes (`arrayBufferBody()` is the manual-read counterpart). Uploads: `parseMultipart` streams file parts without buffering — pair with `pipeToFile` from `@minostack/runtime-node` to land them on disk.

## Runtime adapters (separate packages)

- `@minostack/runtime-node` — `serve(app, { port })`, `toRequest`/`toNodeResponse`
- `@minostack/runtime-bun` — `serve(app, { port })` via `Bun.serve`
- `@minostack/runtime-deno` — `serve(app, { port })` via `Deno.serve`

## Security defaults

| Default             | Value                                                                                            | Override                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Body cap            | 100kb JSON/text/form → `413`; multipart 10 files / 5MB per file → `413`                          | `new Mino({ limits: { json: N, fileCount, fileSize } })` or per-route `validator(..., { limit })` |
| Query/header bounds | 100 keys, 8kb single value, 1kb key names → `400`; magic keys (`__proto__`…) are inert data      | `MinoOptions.limits`                                                                              |
| Cookie bounds       | 100 cookies, 8kb per value → `400`                                                               | fixed                                                                                             |
| URI caps            | 2048 chars / 128 slashes path, 16384 total URL → `414` (Node request-line parity)                | `MinoOptions.limits.urlLength`                                                                    |
| Route params        | 100 chars decoded per `:param` → miss/404 (Fastify `maxParamLength` parity; wildcards unbounded) | `MinoOptions.limits.paramLength`                                                                  |
| Router 400          | fixed `"Bad Request"` + `code`, never echoes segment bytes                                       | fixed                                                                                             |
| 5xx errors          | generic `"Internal Server Error"`, no stack/message leak                                         | `app.onError()`                                                                                   |
| Proxy               | `trustProxy` unset → `X-Forwarded-For` ignored (spoof-safe)                                      | `trustProxy: true \| N`                                                                           |
| Sub-paths           | all opt-in, zero core weight (see Sub-paths)                                                     | import `@minostack/mino/<name>`                                                                   |

Strict middleware contract: every non-terminal handler must `return Response` or `await next()` — forgetting both fails closed with `500` instead of silently advancing.

## Migration from Express

```ts
// express.json({ limit }) → built-in, 100kb default
const app = new Mino({ limits: { json: 100 * 1024 } });

// helmet / cors / rate-limit / timeout → sub-path imports
import { helmet } from "@minostack/mino/helmet";
import { cors } from "@minostack/mino/cors";
import { rateLimit } from "@minostack/mino/rate-limit";
app.use(helmet(), cors({ origin: ["https://example.com"] }), rateLimit({ max: 100 }));

// error middleware → onError (PII-scrub here, never log issues verbatim)
app.onError(
  (err, c) =>
    new Response(JSON.stringify({ error: "Internal Server Error", status: 500 }), { status: 500 }),
);
```

## Versioning

Pre-`1.0.0`: anything may change between `0.x`/`alpha`/`beta` tags — the
`test/api-freeze.test.ts` export list is the machine-readable contract and any
change to it ships with a changeset note. After `1.0.0`: SemVer — new sub-paths
and additive options are minor, export renames/removals and default-behavior
changes are major with a migration note. Deprecated APIs get one minor line of
warnings before removal.

## Performance philosophy

- Low allocations on the request path (lazy `Context`, pre-split paths)
- No per-request regex or temporary arrays (future compressed radix optimization)
- Benchmark harness in `apps/benchmark`: fetch micro-bench (in-process) + autocannon network bench (real sockets, authoritative for vs-Express claims — fetch-bench Express runs mocked req/res).

See `AGENTS.md` and `prompt.md` for architecture.
