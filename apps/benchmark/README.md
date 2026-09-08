# @minostack/benchmark

Reproducible benchmark harness per prompt §31-32 — **Mino vs Hono vs Express v5** across **Node / Bun / Deno**.

> **Both Runtimes — Node.js (3 frameworks) & Bun (Mino vs Hono only)**
>
> - **Node.js:** compares **Mino, Hono, Express v5** (all three) via `app.fetch` + `autocannon` — Express is Node-only, so Node is the only runtime where all three can be compared.
> - **Bun:** compares **Mino vs Hono only** (Express auto-skipped, `runtime !== "node"`) — both are Fetch-native and run natively on Bun via `Bun.serve` / `app.fetch`. Bun is **1.7× faster overall** than Node on same hardware (verified: `static` moderate — Bun: Hono 295k vs Mino 123k; Node: Hono 106k vs Mino 73k).
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
- **express@5** — Express 5.2 via `node-mocks-http` fetch wrapper (Node only; skipped on Bun/Deno)

All frameworks run **equivalent routes** for fair comparison (same path, method, handler shape).

## Run — Both Runtimes

```bash
# Node.js: all three (Mino/Hono/Express) — the only runtime where all three can be compared
pnpm --filter @minostack/benchmark bench              # Node: all: Mino/Hono/Express
pnpm --filter @minostack/benchmark bench:mino         # Node: mino only
pnpm --filter @minostack/benchmark bench:hono         # Node: hono only
pnpm --filter @minostack/benchmark bench:express      # Node: express only
pnpm --filter @minostack/benchmark bench:sequential   # Node: fetch (3) + network (autocannon) → data/latest.json + report.html

# Bun: Mino vs Hono only (Express auto-skipped) — Bun is first-class
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
| **Node.js** | `pnpm bench` / `bench:sequential`         | **Mino, Hono, Express** (3)           | Express is Node-only (`runtime !== "node"` check) — only Node can compare all three                                    |
| **Bun**     | `pnpm bench:bun` / `bench:bun:sequential` | **Mino vs Hono** (2, Express skipped) | Both are Fetch-native, run natively on Bun via `Bun.serve`/`app.fetch`; Bun is ~1.7× faster than Node on same hardware |

## Sequential All Runner — Save to `data/` + Visual Report

The benchmark is **sequential** by design (not parallel) — loops `scenario → workload → framework` with `await`, so results are deterministic and not contended. **Both runtimes are handled:** Node runs 3, Bun runs 2, each saves `data/latest-${runtime}.json`.

Every `bench` run **automatically saves** a structured report for visual consumption:

```bash
# Full sequential (fetch micro + network) — saves to data/
pnpm --filter @minostack/benchmark bench:sequential          # Node: 3 frameworks
pnpm --filter @minostack/benchmark bench:bun:sequential      # Bun: 2 frameworks (Mino/Hono)
pnpm --filter @minostack/benchmark bench:sequential:quick    # quick: mino static + network 2s

# All runtimes sequentially (Node 3 + Bun 2) — for side-by-side comparison
pnpm --filter @minostack/benchmark bench:all-runtimes
# → runs Node (tsx) then Bun (bun) sequentially, saves data/latest-node.json + latest-bun.json

# After any bench, data is already saved:
ls apps/benchmark/data/
# → latest.json              # current runtime (node or bun, overwritten each run)
# → latest-node.json         # Node: Mino/Hono/Express
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
# or: open apps/benchmark/data/report-node.html (Node only: Express vs Hono vs Mino)
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
- **Bar chart: Throughput (Req/s, moderate)** — grouped by scenario, Mino (indigo) vs Hono (amber) vs Express (emerald, Node only)
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

For network:

```
Framework  |     Req/s |   Avg ms |     p50 |     p95 |     p99 |    Err | Timeout
mino       |     20326 |     0.10 |    0.00 |    1.00 |    2.00 |      0 |        0
hono       |     16414 |     0.04 |    0.00 |    0.00 |    1.00 |      0 |        0
express    |     30088 |     0.02 |    0.00 |    0.00 |    1.00 |      0 |        0
```

## Runtimes

- **Node:** `pnpm --filter @minostack/benchmark bench` — **Mino/Hono/Express** (3) via `performance.now()` + `autocannon`
- **Bun:** `pnpm --filter @minostack/benchmark bench:bun` — **Mino vs Hono** (2, Express skipped) via `Bun.serve` / `app.fetch`
- **Deno:** `deno run --allow-all apps/benchmark/src/index.ts` — **Mino vs Hono** (2)

Express is **Node-only** — skipped automatically on Bun/Deno (per `runtime !== "node"` in `createExpressApp()`).

Hono works on all runtimes via `app.fetch`; Express is compared only on Node. **Both runtimes are first-class:** `bench` (Node, 3) and `bench:bun` (Bun, 2) share the same `src/index.ts` (runtime-agnostic `app.fetch` + `performance.now()`), and `bench:sequential` / `bench:all-runtimes` saves `data/latest-${runtime}.json` for side-by-side.

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

- **Fetch micro-benchmark** is in-process, no TCP — best for router/middleware/context overhead.
- **Network benchmark** (`bench:network` / `bench:sequential`) uses `autocannon` over `127.0.0.1` with `runtime-node` for Mino, `hono` via `toRequest`/`toNodeResponse`, `express` via `app.listen` — **Node only** (Bun network uses `Bun.serve`, but `autocannon` is Node-only, so Bun network is skipped).
- **Sequential** — `bench:sequential` (Node, 3) and `bench:bun:sequential` (Bun, 2) run fetch (1) then network (2, Node only) in order, saves `data/sequential-latest.json` + `sequential-latest-${runtime}.json` + visual. `bench:all-runtimes` runs Node then Bun sequentially for combined `latest-node.json` + `latest-bun.json`.
- **Visual** — `data/report.html` (current) + `report-node.html` / `report-bun.html` are self-contained dashboards (Chart.js 4.4 + Tailwind CDN, dark, Inter/JetBrains Mono, gradient header, 2 charts + table). Just open in browser; data is embedded as JSON + also fetched from `latest.json` if available. No server needed.
- For honest numbers, run on isolated machine, no other load, `NODE_OPTIONS=--expose-gc` (Node) / `BUN_OPTIONS` (Bun) for GC metrics, and report `pnpm build` + `node --version` / `bun --version` + `hono --version` etc.

See `src/index.ts` (fetch), `src/network.ts` (autocannon), `src/sequential.ts` (sequential runner) for harness.
