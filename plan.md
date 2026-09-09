# Enterprise-parity preview plan — dev-mode only

> Agreed 2026-09-09. Goal: bring `Mino + Kernel` to functional enterprise parity
> with Express/NestJS for preview/dev-mode use. Production proof is explicitly
> out of scope: no publishing, LTS, compliance certification, performance
> guarantees, or production case studies.

## Locked decisions

- Resilience primitives ship as individual `mino/*` entries:
  - `@minostack/mino/retry`
  - `@minostack/mino/circuit-breaker`
  - `@minostack/mino/bulkhead`
  - `@minostack/mino/idempotency`
- Enterprise boundaries ship as optional packages:
  - `@minostack/config`
  - `@minostack/events`
  - `@minostack/cache`
  - `@minostack/jobs`
- OIDC preview supports:
  - Authorization-code + PKCE.
  - Client credentials.
  - Device authorization flow.
- Canonical API versioning is URL versioning:
  - `/v1/...`
  - `/v2/...`
- Header/media-type versioning is non-canonical for preview.

## Objective

The target outcome is:

> A developer can build a structured, secure, observable, resilient,
> contract-first enterprise backend in dev-mode using only MinoStack
> abstractions, with infrastructure dependencies expressed as replaceable
> ports/adapters.

## Non-goals

Explicitly out of scope:

- `changeset publish`, npm release, LTS/support policy.
- SOC2/ISO/compliance certification or auditor-facing guarantees.
- Production performance leadership claims.
- Vendor-specific ORM, queue, cloud, or SaaS integrations.
- Production incident tooling and operational runbooks.

## Baseline

Already available:

- `packages/mino/src`:
  - Fetch-native core: `mino.ts`, `router.ts`, `context.ts`, `compose.ts`.
  - Validation: `validator.ts`, `validatorAsync`, Standard Schema compatibility.
  - Contracts: `contract.ts`, `client.ts`.
  - Security primitives: `helmet`, `cors`, `cookie`, `jwt`, `paseto`, `csrf`,
    `session`, `basic-auth`, `bearer-auth`, `ip-restriction`.
  - Reliability primitives: `timeout`, `rate-limit`, `under-pressure`, `proxy`,
    `cache`.
  - Operations primitives: `request-id`, `logger`, `response-time`.
- `packages/kernel/src`:
  - Deterministic modules, DI container, scopes, lifecycle, execution context.
  - Guards, pipes, interceptors, exceptions, DTO registry.
  - OTel-compatible tracing abstractions with `NoopTracer`.
- Contract projections:
  - `packages/openapi/src/mino.ts`
  - `packages/graphql/src/mino.ts`
- Runtime adapters:
  - `packages/runtime-node/src/index.ts`
  - Bun/Deno equivalents.

Current gaps are mainly enterprise identity, authorization modeling,
resilience policies, lifecycle/operations standardization, API lifecycle
tooling, data/background abstractions, and test ergonomics.

## Architecture constraints

All work must preserve:

```text
Schema = canonical data truth
Kernel = deterministic application architecture
Mino = minimal Fetch-native HTTP transport
Adapters = runtime-specific behavior
```

Additional constraints:

- Keep `@minostack/mino` core dependency-free and runtime-agnostic.
- Keep new HTTP capabilities as opt-in `mino/*` sub-paths.
- Keep enterprise composition in Kernel or explicit integration boundaries.
- Do not introduce vendor SDK dependencies into core packages.
- Prefer interfaces plus in-memory/dev adapters over concrete infrastructure.
- Preserve explicit `exports`, `sideEffects:false`, ESM-only packaging.
- Maintain uniform Vitest coverage and API-freeze discipline.

## Revised package boundaries

```text
@minostack/schema
  ↑
@minostack/config
@minostack/events
@minostack/cache
@minostack/jobs

@minostack/schema
  ↑
@minostack/kernel
  ↑
Mino as HTTP transport

Mino core stays usable without:
- Kernel
- Config
- Events
- Cache
- Jobs
```

Proposed responsibilities:

- **`@minostack/config`**
  - Schema-backed config definition.
  - Environment/object/file sources.
  - Validation and fail-fast startup errors.
  - Secret redaction.
  - Immutable resolved config.

- **`@minostack/events`**
  - Schema-backed domain-event envelope.
  - Publisher interface.
  - Transactional outbox interface.
  - Dead-letter conventions.
  - In-memory/dev implementation.

- **`@minostack/cache`**
  - Namespaced cache port.
  - TTL and negative-caching controls.
  - Stampede-protection interface.
  - Memory implementation for dev/tests.

- **`@minostack/jobs`**
  - Job definition and retry metadata.
  - Scheduler interface.
  - Worker execution context.
  - In-memory scheduler for dev/tests.

Each new package must include:

- Explicit `exports`.
- `src/index.ts`.
- Unit tests.
- Integration tests through Kernel where applicable.
- Deterministic fakes where time or external behavior is involved.
- README with dev-mode limitations.

## Phase P0 — Enterprise contract and error model

### P0.1 Standard enterprise error catalog

Define a shared error-code taxonomy usable by both Mino and Kernel.

Suggested location:

- Extend `packages/mino/src/errors.ts`
- Map Kernel exceptions in `packages/kernel/src/exceptions.ts`

Include:

- Authentication: invalid token, expired token, missing credentials.
- Authorization: forbidden, missing permission, missing role.
- Validation: malformed body, schema violation, incompatible content type.
- Resilience: timeout, overloaded, bad gateway, unavailable.
- Conflict/state: not found, already exists, precondition failed.
- Enterprise operations: unhealthy dependency, not ready, shutting down.

Acceptance:

- Stable `{ error, status, code }` responses.
- No internal messages, stack traces, secrets, PII, upstream details, or path
  bytes in error bodies.
- Kernel and Mino errors interoperate through existing exception-filter
  behavior.

### P0.2 API envelope and pagination conventions

Add optional, non-breaking response conventions:

- Success envelope helper.
- Error envelope helper.
- Cursor/offset pagination schemas.
- Problem-detail-compatible error shape where useful.

These should be helpers/conventions, not mandatory framework behavior.

Acceptance:

- Existing handlers continue working unchanged.
- OpenAPI generation can describe envelopes and paginated responses.
- Examples demonstrate both minimal and enterprise response styles.

## Phase P1 — Enterprise identity and authorization

### P1.1 Authentication context standard

Introduce a common authentication principal model consumable by:

- Mino middleware.
- Kernel guards.
- Execution context.
- Audit logging.

Conceptual shape:

```text
Principal
├── subject
├── tenant/organization
├── roles
├── permissions/scopes
├── authentication method
├── token metadata
└── trace/request correlation
```

Build on existing JWT/PASETO/session primitives rather than replacing them.

Acceptance:

- JWT, PASETO, bearer, basic, and session flows can populate the same principal
  shape.
- Missing/invalid credentials produce standardized 401 responses.
- No credentials or tokens in logs.

### P1.2 OIDC/OAuth login boundary for dev-mode

Add a runtime-agnostic OIDC/OAuth helper layer without bundling a vendor SDK.

Scope:

- Authorization-code + PKCE.
- Client credentials.
- Device authorization flow.
- Authorization redirect construction.
- State/nonce/PKCE utilities.
- Callback validation interface.
- Token exchange boundary injectable by the application.
- JWKS retrieval/caching interface with dev-mode in-memory implementation.
- Device authorization request handling.
- Device/user codes and verification URI handling.
- Polling interval, `authorization_pending`, and `slow_down` behavior.
- Device-flow expiry and denial handling.
- Correlation across device request, user approval, and token issuance.

Acceptance:

- All three flows work against a fake OIDC provider.
- JWKS rotation is covered by tests.
- Core remains free of OAuth vendor dependencies.

### P1.3 Refresh, rotation, and session lifecycle

Extend session/token handling with enterprise lifecycle behavior:

- Access/refresh separation.
- Refresh-token rotation and reuse detection interfaces.
- Session revocation interface.
- Cookie-backed and server-store session parity.
- Secret rotation support.

Acceptance:

- A reused refresh token can invalidate the associated session chain in the
  dev-mode store.
- Rotation behavior is covered by deterministic tests.
- Key rotation does not require changing route code.

### P1.4 RBAC/ABAC authorization model

Add Kernel-first authorization primitives:

- Role guard.
- Permission/scope guard.
- Tenant guard.
- Policy interface for attribute-based decisions.
- Composable guard ordering semantics.

Acceptance:

- Authorization failures return standardized 403 responses.
- Policy decisions are inspectable/testable without HTTP.
- The same policy can be exercised through Mino and Kernel paths.

### P1.5 Audit events

Introduce schema-backed audit event abstractions:

- Authentication events.
- Authorization decisions.
- Sensitive-data access.
- Administrative actions.
- Background job outcomes.

Acceptance:

- Audit events have stable schema, timestamp, actor, tenant, and trace
  correlation.
- Dev-mode sink supports in-memory capture for tests.
- Secrets and sensitive payloads are redacted by construction.

## Phase P2 — Resilience and enterprise HTTP behavior

Packaging is locked to individual Mino entries:

- `@minostack/mino/retry`
- `@minostack/mino/circuit-breaker`
- `@minostack/mino/bulkhead`
- `@minostack/mino/idempotency`

### P2.1 Retry with budgets

Add opt-in retry policy for outbound calls and proxy/upstream behavior:

- Max attempts.
- Backoff/jitter strategy.
- Retryable status/method classification.
- Overall deadline separate from per-attempt timeout.
- Idempotency awareness.

Acceptance:

- Non-idempotent requests are not retried by default.
- Retry storms are bounded by attempts plus deadline.
- Deterministic tests using fake clocks/fetches.

### P2.2 Circuit breaker

Add runtime-agnostic circuit-breaker primitive:

- Closed/open/half-open states.
- Failure threshold and reset timeout.
- Distinction between upstream failure and local validation failure.
- Metrics/observation hooks.

Acceptance:

- Repeated upstream failures short-circuit without calling upstream.
- A successful probe restores traffic.
- State transitions are covered by deterministic tests.

### P2.3 Bulkhead and concurrency limits

Add concurrency isolation for expensive routes or downstream dependencies:

- Named bulkheads.
- Queue depth/wait budget.
- Fast rejection with standardized 429/503 behavior.

Acceptance:

- One saturated bulkhead does not block unrelated routes.
- Rejections include `Retry-After` where appropriate.
- No unbounded in-memory queues.

### P2.4 Idempotency keys

Add idempotency-key support for unsafe operations:

- Header-based key extraction.
- Request fingerprinting interface.
- Response replay for duplicate keys.
- Storage interface with dev-mode memory implementation.
- TTL/expiry semantics.

Acceptance:

- A duplicate POST with the same key returns the original result without
  re-executing the handler.
- A different payload with the same key is rejected as a conflict/misuse.
- The storage backend is replaceable.

### P2.5 Proxy and upstream hardening

Extend existing proxy behavior with enterprise controls:

- Upstream allowlist.
- Per-upstream timeout and retry policy.
- Header/credential forwarding policy.
- Response size bounds.
- Standardized generic `502` behavior retained.

Acceptance:

- Disallowed upstream targets are rejected before fetch.
- No upstream secrets/details leak downstream.
- Proxy policies compose with resilience primitives without turning `proxy()`
  into a monolithic gateway.

## Phase P3 — Lifecycle, configuration, health, and operations

### P3.1 Standard health model

Add opt-in health endpoints and dependency checks:

- Liveness: process/application alive.
- Readiness: ready to receive traffic.
- Dependency checks: database, cache, upstream APIs, storage.
- Degraded status without leaking internal details.

Acceptance:

- Health responses use a stable schema and status codes.
- Expensive checks support caching/timeouts.
- Health routes can bypass auth but expose no sensitive data.

### P3.2 Graceful startup/shutdown semantics

Standardize application lifecycle across adapters:

- Startup order: config → modules → providers → lifecycle hooks → routes →
  ready.
- Shutdown order: stop accepting work → drain → stop providers → destroy.
- Request cancellation propagation where supported.
- Adapter-level shutdown contract tests.

Acceptance:

- `Application.start/stop` behavior is deterministic and documented.
- In-flight behavior during shutdown is explicit and tested.
- Runtime adapters honor the same shutdown contract.

### P3.3 Configuration system

Implement `@minostack/config`:

- Environment source.
- File/object source for dev/test.
- Schema-backed validation using `@minostack/schema`.
- Namespaced configuration.
- Secret redaction in logs/errors.
- Immutable resolved configuration.

Acceptance:

- Invalid config fails fast at startup with actionable errors.
- Secrets never appear in logs, health output, or errors.
- Tests can override config deterministically.

### P3.4 Request correlation and structured operations logging

Standardize correlation across Mino and Kernel:

- Request ID generation/propagation.
- Trace ID propagation.
- Tenant/user correlation without PII leakage.
- Structured operation events.
- Redaction policy for headers, bodies, errors, and audit fields.

Acceptance:

- Every request can be correlated across middleware, guards, services, and
  outbound calls.
- Logs remain free of tokens, secrets, PII, and full validation payloads.
- Logging behavior is covered by redaction tests.

### P3.5 Real observability bridge

Upgrade observability from abstraction to usable dev-mode integration:

- W3C `traceparent` parsing/propagation.
- HTTP server spans with route, status, duration.
- Controller/service/database child-span conventions.
- Metrics abstraction: counters, histograms, gauges.
- OTel bridge implemented as optional integration, not core dependency.

Acceptance:

- Traces propagate across Mino → Kernel → outbound fetch.
- Default remains lightweight/noop when telemetry is disabled.
- OTel package remains optional and swappable.

## Phase P4 — API lifecycle and contract-first enterprise workflows

Canonical preview form:

```text
/v1/users
/v2/users
```

### P4.1 Versioning and deprecation conventions

Define enterprise API lifecycle patterns around URL versioning:

- Versioned route organization conventions.
- Sunset/deprecation headers.
- Version-aware OpenAPI documents.
- Backward-compatible evolution guidance.

Header/media-type versioning is explicitly non-canonical for preview.

Acceptance:

- Multiple API versions can coexist in one application.
- Deprecated routes emit standardized metadata.
- Docs show migration from the old to the new contract.

### P4.2 Contract extraction and stronger typed client

Strengthen the existing contract → client path:

- Extract route contracts directly from the Mino route graph.
- Preserve input/output/params schemas.
- Generate strongly typed client operations.
- Validate client request construction where practical.
- Support response-schema validation as opt-in behavior.

Acceptance:

- Client methods reflect server routes without duplicated types.
- Contract drift is caught by tests.
- The current generic proxy remains available for simple cases.

### P4.3 Contract compatibility checks

Add dev-mode compatibility tooling focused on URL versions:

- Detect removed versioned routes.
- Detect renamed/removed fields.
- Detect tightened validation.
- Detect changed status codes or error shapes.
- Distinguish breaking, additive, and safe changes.

Acceptance:

- Breaking fixture changes fail compatibility tests.
- Additive changes pass with report output.
- Compatibility checks run without network access.

### P4.4 OpenAPI enterprise metadata

Extend OpenAPI generation with:

- Security schemes: bearer, OAuth2, OIDC, API key.
- Auth requirements per operation.
- Pagination/envelope components.
- Error components.
- Versioned document output.
- Stable component naming.

Acceptance:

- Generated documents validate against OpenAPI tooling.
- Auth metadata derives from route contracts/guards where possible.
- Manual route-map maintenance is minimized.

### P4.5 GraphQL enterprise projection

Extend GraphQL support beyond SDL conversion where justified:

- Resolver metadata conventions.
- Pagination/connection patterns.
- Error handling conventions.
- Federation/readiness assessment without premature implementation.

Acceptance:

- REST and GraphQL can share canonical schemas.
- GraphQL remains optional for REST-only apps.
- No GraphQL runtime dependency leaks into Mino core.

## Phase P5 — Data, background work, and enterprise boundaries

This phase creates **abstractions and dev adapters**, not infrastructure
lock-in.

### P5.1 Repository and transaction ports

Add persistence boundaries:

- Repository interface.
- Unit-of-work/transaction interface.
- Optimistic concurrency support.
- Mapping between persistence models and schema-backed domain contracts.
- In-memory repository for dev/tests.

Acceptance:

- Application services depend on ports, not database clients.
- Transactional workflows can be tested with fake stores.
- No ORM dependency enters Kernel or the new enterprise packages.

### P5.2 Events and outbox abstractions

Implement `@minostack/events`:

- Domain event schema conventions.
- Event publisher interface.
- Transactional outbox interface.
- In-memory event bus for dev/tests.
- Dead-letter/envelope conventions.

Acceptance:

- Events are schema-backed and trace-correlated.
- Publishing can be tested deterministically.
- No message-broker SDK enters core packages.

### P5.3 Jobs and scheduling abstractions

Implement `@minostack/jobs`:

- Job definition interface.
- Retry/backoff metadata.
- Scheduled-task interface.
- Worker execution context.
- In-memory scheduler for dev/tests.

Acceptance:

- Jobs reuse validation, DI, tracing, and audit primitives.
- Scheduled work is deterministic in tests.
- External queue/cron providers remain replaceable.

### P5.4 Cache abstraction

Implement `@minostack/cache`:

- Namespaced keys.
- TTL semantics.
- Negative-caching policy controls.
- Stampede-protection interface.
- Cache-aside recipes.
- Memory implementation for dev/tests.

Acceptance:

- Application code does not depend on Redis/memory implementation details.
- Cache failures degrade explicitly rather than corrupting behavior.
- Existing `mino/cache` behavior remains transport-focused.

## Phase P6 — Enterprise testing and dev ergonomics

### P6.1 Application test harness

Provide a first-class Kernel test harness:

- Boot module graph in test mode.
- Override providers deterministically.
- Seed config, users, tenants, and permissions.
- Execute requests through `app.fetch`.
- Inspect audit events, jobs, and outgoing calls.

Acceptance:

- Enterprise auth, tenant isolation, and error behavior can be tested without
  sockets.
- Overrides do not leak between tests.
- Request-scoped providers are disposed correctly.

### P6.2 Request-scope lifecycle completion

Finish request-scope semantics:

- Create/dispose request containers deterministically.
- Invoke destruction hooks for request-scoped providers.
- Avoid singleton/request-scope leakage.
- Document scope-selection guidance.

Acceptance:

- Request-scoped resources do not accumulate across requests.
- Scope misuse produces actionable errors.
- Lifecycle behavior is covered by regression tests.

### P6.3 Deterministic fakes

Add shared dev/test utilities for:

- Clocks.
- IDs.
- Random values.
- Fetch/upstream responses.
- OIDC providers, including device-flow polling behavior.
- Event buses.
- Job schedulers.
- Time-based resilience policies.

Acceptance:

- Retry, breaker, idempotency, session rotation, and scheduler tests are
  non-flaky.
- Fakes live outside production import paths where appropriate.
- Examples use the same fakes as tests.

### P6.4 Enterprise reference examples

Add executable examples for:

- Multi-tenant SaaS module structure.
- Authenticated API with RBAC.
- URL-versioned public API.
- Resilient upstream integration.
- Background job plus audit trail.
- Contract-first OpenAPI workflow.

Acceptance:

- Every example is executed by tests.
- Examples use public APIs only.
- Examples demonstrate one enterprise concern clearly.

## Cross-cutting verification

Each phase must update:

1. Unit tests.
2. `Mino#fetch`/Kernel application integration tests.
3. Negative/security tests.
4. Deterministic resilience/time tests.
5. README/docs.
6. API-freeze expectations where public surface changes.
7. Benchmarks only where request-path behavior changes.

Suggested gates per phase:

```text
pnpm check
pnpm build
package-focused vitest suites
API-freeze tests
Docs/examples tests
```

Coverage discipline should remain at the repository’s existing 90×4
expectation.

## Suggested execution order

1. **P0 + P1.1/P1.4** — errors, principals, RBAC/policy.
2. **New enterprise packages** — config → events/cache → jobs.
3. **P1.2/P1.3/P1.5** — OIDC boundary, token lifecycle, audit.
4. **P2** — retry, breaker, bulkhead, idempotency, upstream hardening.
5. **P3** — health, lifecycle, config integration, correlation, observability
   bridge.
6. **P4** — URL versioning, typed client, compatibility, OpenAPI/GraphQL
   maturity.
7. **P5** — repository, events/outbox, jobs, cache integration.
8. **P6** — test harness, request-scope completion, fakes, reference examples.

Config should precede broad enterprise examples. Events/cache/jobs can be
developed in parallel once their port shapes are agreed.

## Main risks

- Export/API-surface sprawl: every enterprise helper needs justification and a
  minimal API.
- Resilience complexity leaking into simple Mino apps: keep policies opt-in.
- Security-sensitive behavior without production proof: label dev-mode
  limitations explicitly.
- DI/decorator magic: preserve deterministic errors and introspection.
- Performance overhead: validate only changed request paths; avoid
  framework-wide gates.
- Infrastructure abstraction overdesign: start with narrow ports and memory
  adapters.
- Optional-package overhead: four new packages require manifests, exports,
  tests, docs, and architectural justification.

## Done means

Dev-mode enterprise parity is achieved when:

- Multi-tenant authenticated APIs can be built without framework forks.
- Auth, config, health, resilience, observability, background work, and
  contracts follow documented patterns.
- Infrastructure remains replaceable through ports/adapters.
- All reference examples pass.
- Repository quality gates pass.
- Public API changes are frozen/test-pinned and documented.
- Remaining production work is explicitly labeled as future production
  hardening, not hidden.
