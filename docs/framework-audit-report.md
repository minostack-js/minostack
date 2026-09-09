# Framework Audit: Mino vs Hono vs Express vs Fastify

> Snapshot: 2026-09-09. Scope: maturity, API stability, enterprise readiness, scalability/performance, and security-standards awareness. Evidence: this repository (verified by reading and running checks), the local benchmark matrix, and current npm/GitHub release facts checked on the snapshot date.

## Rubric

| Category | Weight | What earns points |
|---|---:|---|
| Maturity | 20% | Age, adoption, release cadence, governance, LTS/support policy |
| Stable APIs | 15% | Semver discipline, major-version stability, migration cost, TypeScript types |
| Enterprise readiness | 20% | Ecosystem, auth/session/docs/plugins, hiring pool, support channels, compliance artifacts |
| Scalability and performance | 20% | Measured throughput, latency, memory, and horizontal-scaling story |
| Security standards | 25% | Secure defaults, CVE history and response, validation, OWASP-relevant controls, supply-chain surface |

## Competitor snapshot

- **Hono 4.13.7**, MIT, approximately 59.6M weekly downloads, 5.4k dependents, 31.7k stars, active in September 2026. Zero-dependency, Web-standards, edge-native.
- **Express 5.2.1**, ACTIVE LTS line since 2025-03-31. Express v4 maintenance EOL was scheduled for no sooner than 2026-10-01. Approximately 17M weekly downloads from the v4-era ecosystem.
- **Fastify 5.12.3**, MIT, approximately 10.9M weekly downloads, 5.4k dependents. Fastify v6 is alpha; Fastify v5 shipped a security release in August 2026 with two GHSA fixes backported. AJV validation and Pino logging are built in.
- Express has a compounder risk in its query-parser dependency chain: CVE-2022-24999 (`qs` prototype-pollution/process hang, CVSS 7.5) and the August 2026 `qs` denial-of-service advisory (GHSA-4mjr-xmp4-gh2g).

## Verified Mino strengths

- **Zero runtime dependencies**: `packages/mino/package.json` has no `dependencies` block.
- **Bounded request handling**: 100 KB bodies return 413; 100 query/header keys and 8 KB individual values return 400; 2048-character/128-slash URI limits return 414; issue lists are capped at 50 with 500-character truncation; pipeline cache is bounded at 1024 entries (`context.ts`, `validator.ts`, `mino.ts:464-473`).
- **Leak discipline**: fixed 400 bodies (`mino.ts:393-399`), redacted 5xx output, redacted `console.error` output (`mino.ts:511-517`), `trustProxy` unset means `X-Forwarded-For` is ignored, and CORS does not reflect `*` with credentials.
- **Strict middleware contract**: a non-terminal handler that neither returns a `Response` nor calls `next()` fails closed to 500 (`compose.ts:94-100`). This avoids Express's forgotten-`next()` hang.
- **Engineering discipline**: Standard-Schema interop, contract-first routing, OpenAPI/GraphQL projection packages, typed client, 265 passing tests, an enforced uniform 90% coverage gate, and benchmarks that report losses as well as wins.
- **Measured profile**: Mino is third or fourth in all 24 real-socket matrix cells, but post-GC heap is approximately at parity with Hono, Express, and Fastify (roughly 21–22 MB once warmed). The throughput gap is not explained by obvious memory bloat.

## Verified Mino gaps

| Gap | Severity | Evidence |
|---|---|---|
| Unpublished `0.0.0`, no install base, no LTS or support story | Blocker | `packages/mino/package.json:3`; no advisory process, SBOM, provenance, or release history |
| No auth/session/CSRF/compression/static/JWT ecosystem | High for enterprise adoption | No implementations found in `packages/mino/src`; security helpers are opt-in sub-paths |
| Rate limiting is in-memory and single-process | High for horizontal scale | `rate-limit.ts` token bucket; no shared/distributed-store story |
| Validator is synchronous only | Medium | `parseAsync` is explicitly deferred by the v0.1 scope |
| Node adapter is `node:http` only and requires Node >=22 | Medium for enterprise compatibility | `runtime-node/src/index.ts:7`; no HTTP/2; excludes enterprises pinned to Node 20 LTS |
| No documented clustering, graceful drain, metrics, or tracing hooks | Medium | `serve()` has abort-signal shutdown, but no drain timeout or concurrency-limit guidance |

## Scores

| Framework | Maturity (20) | Stable APIs (15) | Enterprise (20) | Scalability (20) | Security (25) | Overall | Grade |
|---|---:|---:|---:|---:|---:|---:|---|
| Fastify | 9 | 9 | 9 | 9 | 8 | **8.8** | A− · production default |
| Hono | 8 | 8 | 8 | 8 | 8 | **8.0** | A− · production ready |
| Express | 10 | 8 | 9 | 7 | 6 | **7.9** | B+ · production with caveats |
| Mino | 2 | 4 | 3 | 6 | 7 | **4.6** | C · pilot only, not production |

### Score rationale

- **Express security is 6, not lower**: v5 fixed async-error footguns and the project now publishes an LTS policy and timely releases. Secure defaults are still opt-in, however, and the `qs` chain produced two high-severity advisories, including one in August 2026.
- **Mino security is 7, its strongest category**: its posture per line of code is better than Express and broadly comparable to Hono/Fastify by design. It loses points for being unaudited, lacking an advisory process, and leaving several controls opt-in rather than default-on.
- **Mino scalability is 6**: the architecture is bounded and low-allocation, and heap parity supports the design. Throughput trails by roughly 1.5–2× in the local matrix, and the multi-process/shared-state story is not yet implemented.
- **Mino API stability is 4**: the strict contract is good design, but it changed before 1.0. That is correctly handled at 0.x, but the public API is still unproven across a 1.x stability cycle.

## Benchmark evidence

`apps/benchmark/src/matrix.ts` runs 11 scenarios × four frameworks × three runs on Node 22.22.3 and Node 24.16.0, with a 60-second sustained static run and post-GC heap/RSS columns.

- Fastify leads all 24 median-throughput cells, generally by 1.5–2×.
- On Node 24, Express leads Mino in all 11 cells.
- On Node 22, the Express anomaly reproduced across the second full matrix run (tight 8–11k rps across all three runs), consistent with an Express 5.2 × Node 22 effect. It remains unexplained and must not be cited as a Mino win until reproduced on isolated hardware with randomized run order.
- Mino's heap is within the same noise band as the other frameworks after warm-up.
- No claim that Mino “beats Express,” “beats Hono,” or “beats Fastify” is supported by the current matrix.

## Verdict

**Mino is pilot-grade, not production-grade, at 4.6/C.** Nothing in the current code is disqualifying; the gaps are mainly absence of ecosystem, hardening proof, and support infrastructure.

A credible path to production-pilot readiness (~7/B) is:

1. Publish `0.1.0` and establish a security-advisory process.
2. Make security defaults default-on or explicitly warned in production.
3. Add a distributed rate-limit interface, at minimum as a separate adapter package.
4. Add compression, an HTTP/2 adapter, and `parseAsync`.
5. Obtain an external review of the router, validator, and request-limit implementation before 1.0. The codebase is small enough that this would be a meaningful differentiator.

**Recommendation:** use Mino for greenfield pilots where the team controls the threat model and can run Node >=22. Use Express or Fastify for production work that needs a mature ecosystem, compliance artifacts, or horizontal scale this quarter. Use Hono when edge/runtime portability and Web-standards compatibility are the primary requirements.
