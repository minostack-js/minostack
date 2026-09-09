---
"@minostack/mino": minor
"@minostack/kernel": minor
"@minostack/openapi": minor
"@minostack/config": minor
"@minostack/events": minor
"@minostack/cache": minor
"@minostack/jobs": minor
---

Enterprise-parity preview (dev-mode, unpublished): enterprise error catalog
with stable `{error,status,code}` shapes and `Retry-After` support; optional
`mino/envelope` response conventions; shared principal identity with Mino RBAC
middleware and Kernel policy guards plus audit trail; OIDC auth-code/PKCE,
client-credentials, and device-flow boundary with JWKS caching; refresh-token
rotation with reuse detection; resilience sub-paths (`mino/retry`,
`mino/circuit-breaker`, `mino/bulkhead`, `mino/idempotency`); proxy upstream
allowlist and injectable fetch for policy composition; `mino/health`
liveness/readiness; W3C traceparent continuation; URL versioning with Sunset
headers; contract-driven typed client; OpenAPI security fragments and route
compatibility checks; new `@minostack/config`, `@minostack/events`,
`@minostack/cache`, `@minostack/jobs` packages; Kernel repository ports,
request-scope disposal, and test harness with deterministic fakes.
