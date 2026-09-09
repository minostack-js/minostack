# @minostack/benchmark

Reproducible benchmark harness per prompt §31-32 — **Mino vs Hono vs Express v5 vs Fastify v5** across **Node / Bun / Deno**.

> **Both Runtimes — Node.js (4 frameworks) & Bun (Mino vs Hono only)**
>
> - **Node.js:** compares **Mino, Hono, Express v5, Fastify v5** (all four) via `app.fetch` + `autocannon` — Express/Fastify are Node-only, so Node is the only runtime where all four can be compared.
> - **Bun:** compares **Mino vs Hono only** (Express/Fastify auto-skipped, `runtime !== "node"`) — both are Fetch-native and run natively on Bun via `Bun.serve` / `app.fetch`. Bun is **1.7× faster overall** than Node on same hardware (verified: `static` moderate — Bun: Hono 295k vs Mino 123k; Node: Hono 106k vs Mino 73k).
>
> **Sequential runner saves per-runtime data:** `data/latest.json` (current runtime) + `data/latest-node.json` / `latest-bun.json` + `report.html` / `report-node.html` / `report-bun.html` + `history/`. Visual shows `runtime: node` vs `runtime: bun` in header.

## Metrics (per §31)

- `Requests/sec`
- `p50 / p95 / p99 latency`
- `RSS / heapUsed / heapTotal`
- `allocation rate / GC count / pause` (with `NODE_OPTIONS=--expose-gc`)
- `CPU utilization` (via `process.cpuUsage()`)

Each run prints reproducibility header: CPU, RAM, OS, Runtime version, Framework versions, Tool/version, Protocol, Connections, Concurrency, Warm-up, Duration, Payload, Keep-Alive, Error rate.

## Matrix (per §32)

- **Runtime:** Node.js (>=22), Bun, Deno — auto-detected via `process.versions.bun` / `Deno`
- **Route:** static, single param, multi param, wildcard, deeply nested
- **Pipeline:** 0,1,5,10 middleware (sync + async)
- **Context:** minimal, params, URL, headers
- **Response:** small JSON, text, large JSON, streaming
- **Workload:** low (1k×1), moderate (5k×10), high (10k×50)

## Frameworks

- **@minostack/mino** — Fetch-native, via `app.fetch` (always, all runtimes)
- **hono** — `hono` `app.fetch` (dynamic import, skips if not installed, all runtimes)
- **express@5** — Express 5.2 via custom mocked req/res fetch wrapper in `src/index.ts` (Node only; skipped on Bun/Deno). **Not apples-to-apples** — the authoritative Express comparison is `bench:network` / `bench:matrix` (real sockets, see Notes).
- **fastify@5** — Fastify 5.x via `app.inject()` fetch wrapper in `src/index.ts` (Node only; skipped on Bun/Deno) and real sockets (`app.listen`) in `bench:network` / `bench:matrix` (authoritative).

All frameworks run **equivalent routes** for fair comparison (same path, method, handler shape).

## Run — Both Runtimes

```bash
# Node.js: all four (Mino/Hono/Express/Fastify) — the only runtime where all four can be compared
pnpm --filter @minostack/benchmark bench              # Node: all: Mino/Hono/Express/Fastify
pnpm --filter @minostack/benchmark bench:mino         # Node: mino only
pnpm --filter @minostack/benchmark bench:hono         # Node: hono only
pnpm --filter @minostack/benchmark bench:express      # Node: express only
pnpm --filter @minostack/benchmark bench:fastify      # Node: fastify only
pnpm --filter @minostack/benchmark bench:matrix       # Node: real-socket matrix (11 scenarios × 4 fw, medians + sustained)
pnpm --filter @minostack/benchmark bench:sequential   # Node: fetch (4) + network (autocannon) → data/latest.json + report.html

# Bun: Mino vs Hono only (Express/Fastify auto-skipped) — Bun is first-class
pnpm --filter @minostack/benchmark bench:bun           # Bun: Mino vs Hono
pnpm --filter @minostack/benchmark bench:bun:quick     # Bun: quick (mino static)
pnpm --filter @minostack/benchmark bench:bun:all       # Bun: all (Mino/Hono)
pnpm --filter @minostack/benchmark bench:bun:sequential       # Bun sequential (fetch only, network skipped)
pnpm --filter @minostack/benchmark bench:bun:sequential:quick # Bun quick sequential
# or directly:
bun run apps/benchmark/src/index.ts -- --framework=all --scenario=static
bun run apps/benchmark/src/sequential.ts -- --quick

# All runtimes sequentially (Node 3 + Bun 2) — saves data/latest-node.json + latest-bun.json + combined report.html
pnpm --filter @minostack/benchmark bench:all-runtimes
# = bench:sequential (Node) + bench:bun:sequential (Bun) + bench:combine (Node+Bun → report.html)
# or: pnpm --filter @minostack/benchmark bench && pnpm --filter @minostack/benchmark bench:bun && pnpm --filter @minostack/benchmark bench:combine
# Single-runtime detail pages are kept: report-node.html (Node 3) + report-bun.html (Bun 2)

# Filters (both runtimes)
pnpm --filter @minostack/benchmark bench -- --framework=mino --scenario=static  # Node: mino static
bun run apps/benchmark/src/index.ts -- --framework=hono --scenario=param --verbose  # Bun: hono param

# Network (autocannon, Node only, 10 conn, 5s)
pnpm --filter @minostack/benchmark bench:network
pnpm --filter @minostack/benchmark bench:network:quick
NODE_OPTIONS=--expose-gc pnpm --filter @minostack/benchmark bench  # + GC
```

**What each runtime compares:**

| Runtime     | `bench` / `bench:sequential`              | Frameworks                            | Why                                                                                                                    |
| ----------- | ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Node.js** | `pnpm bench` / `bench:sequential`         | **Mino, Hono, Express, Fastify** (4)  | Express/Fastify are Node-only (`runtime !== "node"` check) — only Node can compare all four                            |
| **Bun**     | `pnpm bench:bun` / `bench:bun:sequential` | **Mino vs Hono** (2, Express skipped) | Both are Fetch-native, run natively on Bun via `Bun.serve`/`app.fetch`; Bun is ~1.7× faster than Node on same hardware |

## Sequential All Runner — Save to `data/` + Visual Report

The benchmark is **sequential** by design (not parallel) — loops `scenario → workload → framework` with `await`, so results are deterministic and not contended. **Both runtimes are handled:** Node runs 4, Bun runs 2, each saves `data/latest-${runtime}.json`.

Every `bench` run **automatically saves** a structured report for visual consumption:

```bash
# Full sequential (fetch micro + network) — saves to data/
pnpm --filter @minostack/benchmark bench:sequential          # Node: 4 frameworks
pnpm --filter @minostack/benchmark bench:bun:sequential      # Bun: 2 frameworks (Mino/Hono)
pnpm --filter @minostack/benchmark bench:sequential:quick    # quick: mino static + network 2s

# All runtimes sequentially (Node 3 + Bun 2) — for side-by-side comparison
pnpm --filter @minostack/benchmark bench:all-runtimes
# → runs Node (tsx) then Bun (bun) sequentially, saves data/latest-node.json + latest-bun.json

# After any bench, data is already saved:
ls apps/benchmark/data/
# → latest.json              # current runtime (node or bun, overwritten each run)
# → latest-node.json         # Node: Mino/Hono/Express/Fastify
# → latest-bun.json          # Bun: Mino/Hono
# → latest.csv / latest-node.csv / latest-bun.csv
# → report.html              # visual for current runtime
# → report-node.html / report-bun.html
# → history/benchmark-2026-09-08T16-30-00.json
# → sequential-latest.json / sequential-latest-node.json / sequential-latest-bun.json
# → history/sequential-...

# Visual — open in browser
pnpm --filter @minostack/benchmark bench:visual
# → open apps/benchmark/data/report.html (COMBINED: Node 3 + Bun 2 + crossover — default after bench:all-runtimes / bench:combine)
# or: open apps/benchmark/data/report-node.html (Node only: Mino vs Hono vs Express vs Fastify)
# or: open apps/benchmark/data/report-bun.html (Bun only: Hono vs Mino)
# NOTE: single-runtime `bench` overwrites report.html with that runtime only — run `bench:combine` to restore combined view
```

**`data/latest.json` shape:**

```json
{
  "timestamp": "2026-09-08T16:31:59.875Z",
  "system": { "runtime": "node", "node": "v24.16.0", "cpu": "12th Gen...", "cores": 12, "ram": "15.3 GB" },
  "versions": { "@minostack/mino": "workspace", "hono": "4.13.7", "express": "5.2.1" },
  "results": [
    { "name": "static (low)", "framework": "mino", "rps": 59567, "avgMs": 0.016, "p50": 0.011, "p95": 0.024, "p99": 0.068, "errors": 0, "rssMB": 113.7, "heapUsedMB": 18.2, "cpuUserMs": 23.8 }
  ],
  "config": { "scenarios": ["static", "param", ...], "workloads": [{"name":"low","iterations":1000,"concurrency":1}, ...] }
}
```

**Visual `data/report.html` / `report-bun.html`:**

- Gradient header with `runtime: node` vs `runtime: bun`, system/versions/timestamp
- 4 summary cards (scenarios, frameworks, total runs, fastest avg)
- **Bar chart: Throughput (Req/s, moderate)** — grouped by scenario, Mino (indigo) vs Hono (amber) vs Express (emerald, Node only) vs Fastify (sky, Node only)
- **Bar chart: Latency p95 (moderate)** — lower is better
- **Detailed table** (10 cols: Scenario, Workload, Framework, Req/s, Avg, p50, p95, p99, Err%, Heap)
- **Reproducibility** block (§31) + Download JSON/CSV + History
- Self-contained, uses `https://cdn.jsdelivr.net/npm/chart.js` + `https://cdn.tailwindcss.com` — no build step, just open `data/report.html`

**History for trends:**

```bash
ls apps/benchmark/data/history/
# benchmark-2026-09-08T16-31-59.json          # Node
# benchmark-bun-2026-09-08T16-45-35.json      # Bun
# sequential-...json / sequential-bun-...json
# Use for CI trends: diff latest vs history, or ingest CSV into Grafana/BI
```

## Output

```
# Node (3 frameworks)
Scenario         | Workload   | Framework  |     Req/s |   Avg ms |     p50 |     p95 |     p99 |   Err% |   RSS MB |   Heap MB |   CPU ms
static           | moderate   | mino       |     73548 |    0.014 |   0.109 |   0.187 |   0.465 |   0.00 |    185.9 |      70.7 |      113
static           | moderate   | hono       |    106898 |    0.009 |   0.077 |   0.129 |   0.241 |   0.00 |    193.9 |      58.8 |      120
static           | moderate   | express    |     34974 |    0.029 |   0.199 |   0.320 |   0.580 |   0.00 |    310.1 |     128.5 |      197
=== Summary: fastest hono 106k | mino 73k (68.8%) ===

# Bun (2 frameworks, Express skipped)
Scenario         | Workload   | Framework  |     Req/s |   Avg ms |     p50 |     p95 |     p99 |   Err% |   RSS MB |   Heap MB |   CPU ms
static           | moderate   | mino       |    123567 |    0.008 |   0.070 |   0.149 |   0.290 |   0.00 |    104.9 |       2.5 |       94
static           | moderate   | hono       |    295175 |    0.003 |   0.027 |   0.061 |   0.095 |   0.00 |    110.0 |       3.3 |       39
=== Summary: fastest hono 295k | mino 123k (41.9%) ===

# After each run:
📊 Report saved: .../data/latest.json (also .../latest-bun.json)
🌐 Visual: .../data/report.html (also .../report-bun.html)
```

For network (`bench:network`, single `/hello` probe):

```
Framework  |     Req/s |   Avg ms |     p50 |     p95 |     p99 |    Err | Timeout
mino       |     20326 |     0.10 |    0.00 |    1.00 |    2.00 |      0 |        0
hono       |     16414 |     0.04 |    0.00 |    0.00 |    1.00 |      0 |        0
express    |     30088 |     0.02 |    0.00 |    0.00 |    1.00 |      0 |        0
```

## Real-socket matrix, Phase D2 (authoritative)

`bench:matrix` (`src/matrix.ts`) runs all **11 scenarios** × {mino, hono, express, fastify} over **real listening sockets** via autocannon (`127.0.0.1`, 10 connections, 5s, **3-run medians**), plus a **60s sustained** static run and **post-GC heap/RSS** columns. Raw artifacts: `data/matrix-node<ver>.json` + `data/matrix-node<ver>.csv` (+ `history/` copies). Median req/s per scenario:

**Node v24.16.0** (2026-09-09, i5-1235U x12, Linux x64):

| Scenario      | mino  | hono  | express | fastify | fastest |
| ------------- | ----- | ----- | ------- | ------- | ------- |
| static        | 21064 | 24155 | 24917   | 36445   | fastify |
| param         | 18587 | 22322 | 24520   | 36662   | fastify |
| multi-param   | 17970 | 20213 | 22510   | 35293   | fastify |
| wildcard      | 18846 | 27534 | 23518   | 37443   | fastify |
| deep-nested   | 19227 | 20834 | 24795   | 40714   | fastify |
| middleware-1  | 18901 | 22229 | 24222   | 40490   | fastify |
| middleware-5  | 18114 | 20408 | 26827   | 41194   | fastify |
| middleware-10 | 13662 | 19448 | 19672   | 33309   | fastify |
| small-json    | 14274 | 16348 | 21758   | 32302   | fastify |
| text          | 14150 | 19435 | 21218   | 32102   | fastify |
| large-json    | 12498 | 13431 | 13914   | 25131   | fastify |
| sustained-60s | 15058 | 18397 | 20456   | 35101   | fastify |

**Node v22.22.3** (same machine, same day):

| Scenario      | mino  | hono  | express | fastify | fastest |
| ------------- | ----- | ----- | ------- | ------- | ------- |
| static        | 19448 | 19352 | 9220    | 29888   | fastify |
| param         | 16501 | 17592 | 9407    | 31110   | fastify |
| multi-param   | 14073 | 16544 | 9270    | 27261   | fastify |
| wildcard      | 16932 | 24808 | 11441   | 36854   | fastify |
| deep-nested   | 17434 | 12017 | 8700    | 29742   | fastify |
| middleware-1  | 17333 | 19192 | 9636    | 35870   | fastify |
| middleware-5  | 16266 | 19739 | 10550   | 36440   | fastify |
| middleware-10 | 15706 | 18910 | 9762    | 37955   | fastify |
| small-json    | 17550 | 18427 | 9884    | 37418   | fastify |
| text          | 17159 | 20434 | 10372   | 37648   | fastify |
| large-json    | 15073 | 16823 | 9346    | 29886   | fastify |
| sustained-60s | 17471 | 21041 | 11254   | 35066   | fastify |

**Reading this honestly:**

- The D2 bar ("Mino ≥ Express throughput **and** heap on all 11") is **not met**. On Node 24 Express leads mino in all 11 throughput cells; Fastify leads everything on both runtimes by ~1.5–2×. Heap is at rough parity (~21–22MB post-GC for all four once warmed; early cells read high because module load is attributed to the first cells — run order is mino→hono→express→fastify per scenario).
- The **Node 22 Express collapse (~3× slower than the same Express on Node 24, tight across all 3 runs, reproduced on a second full-matrix run)** looks like an Express 5.2 × Node 22 effect rather than a one-off, but it is still unexplained — **do not cite the Node 22 "mino beats Express" column as a win until it is reproduced on isolated hardware with randomized run order.**
- No "beats Express"/"beats Hono"/"beats Fastify" marketing is supported by this data. Fastify is the throughput leader in all 24 cells; mino trails hono in most cells with heap in the same noise band.

## Runtimes

- **Node:** `pnpm --filter @minostack/benchmark bench` — **Mino/Hono/Express/Fastify** (4) via `performance.now()` + `autocannon`
- **Bun:** `pnpm --filter @minostack/benchmark bench:bun` — **Mino vs Hono** (2, Express skipped) via `Bun.serve` / `app.fetch`
- **Deno:** `deno run --allow-all apps/benchmark/src/index.ts` — **Mino vs Hono** (2)

Express/Fastify are **Node-only** — skipped automatically on Bun/Deno (per `runtime !== "node"` in `createExpressApp()` / `createFastifyApp()`).

Hono works on all runtimes via `app.fetch`; Express/Fastify are compared only on Node. **Both runtimes are first-class:** `bench` (Node, 4) and `bench:bun` (Bun, 2) share the same `src/index.ts` (runtime-agnostic `app.fetch` + `performance.now()`), and `bench:sequential` / `bench:all-runtimes` saves `data/latest-${runtime}.json` for side-by-side.

## Reproducibility Checklist (§31)

Each run logs:

- CPU model/cores, RAM, OS, platform
- Runtime version (`process.version` / `Bun.version` / `Deno.version`)
- Framework versions (from `package.json` via `fs` fallback for `exports` restrictions)
- Tool/version (`performance.now()` + `autocannon` if network)
- Protocol `http/1.1`, keep-alive yes, pipelining 1, connections 10/50, duration 5s
- Warm-up 2000 req, iterations 1k/5k/10k, concurrency 1/10/50
- Payload: small JSON 20B, large JSON ~2KB, text 120B
- Error rate per row (4xx/5xx + thrown)

## Notes

- **Fetch micro-benchmark** is in-process, no TCP — best for router/middleware/context overhead. **Express runs through a mocked req/res wrapper here (Fastify via `app.inject`), while Mino/Hono run native `app.fetch` — do NOT cite fetch-bench Express deltas as throughput wins.**
- **Network benchmark** (`bench:network` / `bench:sequential` / `bench:matrix`) uses `autocannon` over `127.0.0.1` with `runtime-node` for Mino, `hono` via `toRequest`/`toNodeResponse`, `express`/`fastify` via `app.listen` — **Node only** (Bun network uses `Bun.serve`, but `autocannon` is Node-only, so Bun network is skipped). **This is the authoritative apples-to-apples comparison — cite these numbers for any "vs Express/Fastify" throughput claim.**
- **Sequential** — `bench:sequential` (Node, 4) and `bench:bun:sequential` (Bun, 2) run fetch (1) then network (2, Node only) in order, saves `data/sequential-latest.json` + `sequential-latest-${runtime}.json` + visual. `bench:all-runtimes` runs Node then Bun sequentially for combined `latest-node.json` + `latest-bun.json`.
- **Visual** — `data/report.html` (current) + `report-node.html` / `report-bun.html` are self-contained dashboards (Chart.js 4.4 + Tailwind CDN, dark, Inter/JetBrains Mono, gradient header, 2 charts + table). Just open in browser; data is embedded as JSON + also fetched from `latest.json` if available. No server needed.
- For honest numbers, run on isolated machine, no other load, `NODE_OPTIONS=--expose-gc` (Node) / `BUN_OPTIONS` (Bun) for GC metrics, and report `pnpm build` + `node --version` / `bun --version` + `hono --version` etc.

See `src/index.ts` (fetch), `src/network.ts` (autocannon), `src/sequential.ts` (sequential runner) for harness.
