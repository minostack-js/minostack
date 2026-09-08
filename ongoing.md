# Ongoing Plan: `@minostack/mino` 0.1.0 — mature, shippable, better than Express v5

> Status 2026-09-08: **Phase A DONE** — limits enforced (`MinoOptions.limits`, 100kb bodies → 413, 100 keys / 8kb values → 400, fixed 400 bodies, 500-char issue truncation), `PayloadTooLargeError` exported, per-route `validator(..., { limit })` override, `test/limits.test.ts` (14 tests). Gates: mino 147/147, `pnpm check` 17/17, `build` 9/9, benchmark re-run + combined.
> Status 2026-09-08 pm: **Phase B + C DONE** — five sub-paths (`helmet`, `cors`, `rate-limit`, `timeout`, `request-id` incl. `logger`), explicit export entries, `trustProxy` + `x-mino-peer` plumbing, log redact, SSE backpressure, `decodeRemainder` scan-then-join, FIFO rationale documented, `compose` middleware contract documented (must RETURN rebuilt responses), `test/secure.test.ts` (19 tests). Gates: mino 166/166, `pnpm check` 17/17, `build` 9/9, dist verified (sub-path imports work), benchmark re-run + combined. Next: Phase D2 (real-socket benchmark matrix), Phase E (LICENSE, changeset, README, publish 0.1.0).

Locked: **100kb body default** · **per-feature sub-paths** (`@minostack/mino/cors`, no grouping) · **publish `0.1.0`** · **security parity + perf lead both required**.

## Baseline (audited, not assumed)

- 11 files `packages/mino/src/`, 8 test files / 133 green, `pnpm check` 17/17, `build` 9/9, `version 0.0.0`, publish shape OK (`exports "."`, `files:[dist]`, `sideEffects:false`).
- Already strong: 5xx-hiding `HttpError` (`errors.ts:42-47`), 414 URI caps (`mino.ts:334-355`), bounded pipeline cache (1024), `MAX_ISSUES=50`, sync-only validator, 200-parallel isolation tests, `serve()` abort propagation + `signal` shutdown in `runtime-node`.
- Gaps: no body-size cap (`validator.ts:77` unbounded `clone().text()`), no helmet/CORS/rate-limit/timeout anywhere (grep-verified), leak shapes (router-400 echo `mino.ts:368-373`, `issues` passthrough `errors.ts:92-102`, `console.error` full error `mino.ts:482`), unbounded query/header materialization, SSE no backpressure, `LICENSE` missing, no changeset for mino, Express benchmark partly mock-based (`index.ts:470-589`).

## Phase A — Demand limits (biggest enterprise blocker)

| #   | Task (files)                                                                                                                                                                                                                                                             | Acceptance                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| A1  | Body cap 100kb default, per-route override. `MinoOptions { limits?: { json?, text?, form? } }`; enforce in `validator.ts:56-86` + `context.ts:232-254` via `content-length` pre-check **and** byte-count while reading; exceed → `413` JSON (text exists `errors.ts:29`) | 99kb passes, 100kb passes, 101kb → 413 `{error,status:413,code}`; existing 500-item test passes |
| A2  | Query/header bounds: max keys 100, single value 8kb in `context.ts:91-111` + `validator.ts:103-104`; exceed → 400                                                                                                                                                        | `?k=v×10k` → 400 without 100k-entry alloc; 8KB header test passes at boundary                   |
| A3  | Router-400 de-echo: `mino.ts:368-373` return fixed `"Bad Request"` + `code`, never `err.message`                                                                                                                                                                         | Bad-`%` fuzz body never contains segment bytes                                                  |
| A4  | Per-issue string truncation (500 chars) in `validator.ts`; document `onError` PII-scrub recipe                                                                                                                                                                           | 60-field test ≤50 issues, each bounded                                                          |

## Phase B — Per-feature sub-paths (no grouping layer)

Flat `src/*.ts`, explicit export entries (verified: `tsc rootDir:src` emits `dist/<name>.js` with no config change; current `package.json:7-12` exposes only `"."`):

```ts
import { helmet } from "@minostack/mino/helmet";
import { cors } from "@minostack/mino/cors";
import { rateLimit } from "@minostack/mino/rate-limit";
import { timeout } from "@minostack/mino/timeout";
import { requestId } from "@minostack/mino/request-id";
```

`package.json` gains 5 explicit entries (no `"./*"` wildcard, per boundary rule):

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./helmet": { "types": "./dist/helmet.d.ts", "import": "./dist/helmet.js" },
  "./cors": { "types": "./dist/cors.d.ts", "import": "./dist/cors.js" },
  "./rate-limit": { "types": "./dist/rate-limit.d.ts", "import": "./dist/rate-limit.js" },
  "./timeout": { "types": "./dist/timeout.d.ts", "import": "./dist/timeout.js" },
  "./request-id": { "types": "./dist/request-id.d.ts", "import": "./dist/request-id.js" }
}
```

| Module          | Beats                | Key behavior                                                                                               |
| --------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `helmet.ts`     | `helmet`             | `nosniff`, `frame-ancestors`, HSTS only on https, `referrer-policy`, `permissions-policy`; all overridable |
| `cors.ts`       | `cors`               | Origin allowlist + auto `OPTIONS` preflight; preserves Mino 405 `Allow`                                    |
| `rate-limit.ts` | `express-rate-limit` | In-memory token bucket, per-IP + `trustProxy` hops, `RateLimit-*` + `Retry-After`, exceed → 429 JSON       |
| `timeout.ts`    | `connect-timeout`    | `AbortSignal`-driven → 408 JSON; composes with adapter abort                                               |
| `request-id.ts` | `morgan` basics      | Generate/propagate `X-Request-Id` + structured JSON access log (never logs `issues` verbatim)              |

Each: unit tests + `Mino#fetch` integration + docs. Root `index.ts:6-35` unchanged → zero added weight to core import.

## Phase C — Core reliability (small diffs)

- C1. `trustProxy` option: hop-count for rate-limit IP + `runtime-node` protocol detection (today only `socket.encrypted` sniff, `runtime-node/src/index.ts:24-27`).
- C2. `mino.ts:482` `console.error` full error → redact or gate on `NODE_ENV !== "production"` (adapter already does this, `runtime-node/src/index.ts:254`).
- C3. SSE backpressure: respect `controller.desiredSize` (`sse.ts:29-44`); document slow-consumer policy.
- C4. `decodeRemainder` O(n²) concat (`router.ts:222-236`) → index-scan on `pathname`.
- C5. Pipeline cache FIFO → LRU (or prove >1024-route apps don't thrash); keep 1024 bound.

## Phase D — Proof

- D1. Tests: extend `hardening.test.ts`, new `test/<feature>.test.ts` per sub-path — 413 boundaries (99/100/101kb), caps, 429 + `Retry-After`, 408, CORS round-trip, helmet presence/override, trust-proxy spoof ignored when untrusted, non-echo fuzz, SSE slow-consumer. Keep mino coverage ≥90% gate.
- D2. Benchmark honesty: move Express comparison to **real sockets** (`network.ts` pattern — Express already native `app.listen(0)` there) across all 11 scenarios, Node 22 + 24, 3-run medians, plus 60s sustained + post-GC memory columns. Bar: Mino ≥ Express throughput **and** heap on all 11 (today ~9/11 throughput, 11/11 heap), p95 within noise otherwise. Publish `report.html` + raw CSV.
- D3. Gates: `pnpm check` 17/17, `build` 9/9, `pack --dry-run` tarball = `dist/`+manifest+README (re-verify after new export entries).

## Phase E — Ship 0.1.0

- E1. Root `LICENSE` (MIT) — blocker per `AGENTS.md §6`.
- E2. Changeset `@minostack/mino: minor` documenting 100kb default + strict handler contract.
- E3. README: Security defaults table, Migration-from-Express guide (`express.json({limit})`→defaults, `helmet/cors/rate-limit/timeout`→sub-path imports, error-middleware→`onError`), benchmark link + methodology note.
- E4. `changeset publish` from trusted env; release notes with OWASP mapping + benchmark deltas.

## Order, parallelization, risks

Order: **A → C → B → D → E**. A and B are independent — two workers can parallelize (A touches core body paths, B adds new files + export entries; agree the `MinoOptions.limits` + `trustProxy` shapes first to avoid merge friction). C follows A (same files), D follows B/C, E last.

Risks: 100kb default may surprise large-payload users → per-route override + explicit 413 JSON mitigate; 5 export entries = 5 API surfaces → kept minimal by design (one function each); benchmark noise → pinned Node versions, medians, isolated runner.
