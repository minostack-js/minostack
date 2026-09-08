/**
 * Combine Node + Bun benchmark data into a single visual report.
 * Reads data/latest-node.json + data/latest-bun.json
 * Writes data/report.html (combined) — Node: Mino/Hono/Express, Bun: Mino/Hono
 *
 * Run:
 *   pnpm --filter @minostack/benchmark bench:combine
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BenchResult = {
  name: string;
  framework: string;
  iterations: number;
  concurrency: number;
  elapsedMs: number;
  rps: number;
  avgMs: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  errors: number;
  rssMB: number;
  heapUsedMB: number;
  heapTotalMB: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
};

type Report = {
  timestamp: string;
  system: Record<string, unknown>;
  versions: Record<string, string>;
  results: BenchResult[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "../data");

function load(name: string): Report | null {
  const p = path.join(dataDir, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Report;
  } catch {
    return null;
  }
}

function labelsFor(results: BenchResult[]): string[] {
  const moderate = results.filter((r) => r.name.includes("moderate"));
  const labels = [...new Set(moderate.map((r) => r.name.split(" ")[0] ?? r.name))];
  if (labels.length > 0) return labels;
  return [...new Set(results.map((r) => r.name.split(" ")[0] ?? r.name))];
}

function frameworksFor(results: BenchResult[]): string[] {
  return [...new Set(results.map((r) => r.framework))];
}

const colors: Record<string, string> = {
  mino: "#6366f1",
  hono: "#f59e0b",
  express: "#10b981",
};

function rpsDatasets(results: BenchResult[], labels: string[], frameworks: string[]) {
  const moderate = results.filter((r) => r.name.includes("moderate"));
  const src = moderate.length > 0 ? moderate : results;
  return frameworks.map((fw) => ({
    label: fw,
    data: labels.map((label) => {
      const rec = src.find((r) => r.framework === fw && r.name.startsWith(label));
      return rec ? Math.round(rec.rps) : 0;
    }),
    backgroundColor: colors[fw] ?? "#6b7280",
    borderColor: colors[fw] ?? "#6b7280",
    borderWidth: 1,
  }));
}

function p95Datasets(results: BenchResult[], labels: string[], frameworks: string[]) {
  const moderate = results.filter((r) => r.name.includes("moderate"));
  const src = moderate.length > 0 ? moderate : results;
  return frameworks.map((fw) => ({
    label: fw,
    data: labels.map((label) => {
      const rec = src.find((r) => r.framework === fw && r.name.startsWith(label));
      return rec ? Number(rec.p95.toFixed(3)) : 0;
    }),
    backgroundColor: colors[fw] ?? "#6b7280",
    borderColor: colors[fw] ?? "#6b7280",
    borderWidth: 1,
  }));
}

function rowsHtml(results: BenchResult[]): string {
  return results
    .map((r) => {
      const errPct = ((r.errors / r.iterations) * 100).toFixed(2);
      const fc =
        r.framework === "mino"
          ? "text-indigo-400"
          : r.framework === "hono"
            ? "text-amber-400"
            : "text-emerald-400";
      const wl = r.name.includes("low")
        ? "low"
        : r.name.includes("moderate")
          ? "moderate"
          : r.name.includes("high")
            ? "high"
            : "";
      const scenario = r.name.split(" ")[0] ?? r.name;
      return `<tr class="hover:bg-zinc-800/50"><td class="px-4 py-2 font-semibold">${scenario}</td><td class="px-3 py-2">${wl}</td><td class="px-3 py-2 ${fc} font-bold">${r.framework}</td><td class="px-3 py-2 text-right font-bold">${Math.round(r.rps).toLocaleString()}</td><td class="px-3 py-2 text-right">${r.avgMs.toFixed(3)}</td><td class="px-3 py-2 text-right">${r.p50.toFixed(3)}</td><td class="px-3 py-2 text-right">${r.p95.toFixed(3)}</td><td class="px-3 py-2 text-right">${r.p99.toFixed(3)}</td><td class="px-3 py-2 text-right">${errPct}%</td><td class="px-3 py-2 text-right">${r.heapUsedMB.toFixed(1)}</td></tr>`;
    })
    .join("\n");
}

function fastestAvg(results: BenchResult[], frameworks: string[]): string {
  const moderate = results.filter((r) => r.name.includes("moderate"));
  const src = moderate.length > 0 ? moderate : results;
  const avg = frameworks.map((fw) => {
    const rows = src.filter((r) => r.framework === fw);
    const v = rows.reduce((a, b) => a + b.rps, 0) / Math.max(1, rows.length);
    return [fw, v] as const;
  });
  avg.sort((a, b) => b[1] - a[1]);
  const top = avg[0];
  return top ? `${top[0]} ${Math.round(top[1]).toLocaleString()} req/s` : "-";
}

function crossoverRows(node: Report | null, bun: Report | null): string {
  if (!node || !bun)
    return `<tr><td colspan="5" class="px-4 py-3 text-center text-zinc-500">Need both latest-node.json and latest-bun.json — run bench:all-runtimes first</td></tr>`;
  const labels = [...new Set([...labelsFor(node.results), ...labelsFor(bun.results)])];
  return labels
    .map((label) => {
      const nMino = node.results.find(
        (r) => r.framework === "mino" && r.name.startsWith(label) && r.name.includes("moderate"),
      );
      const bMino = bun.results.find(
        (r) => r.framework === "mino" && r.name.startsWith(label) && r.name.includes("moderate"),
      );
      const nHono = node.results.find(
        (r) => r.framework === "hono" && r.name.startsWith(label) && r.name.includes("moderate"),
      );
      const bHono = bun.results.find(
        (r) => r.framework === "hono" && r.name.startsWith(label) && r.name.includes("moderate"),
      );
      const mno = nMino ? Math.round(nMino.rps).toLocaleString() : "-";
      const mbo = bMino ? Math.round(bMino.rps).toLocaleString() : "-";
      const hno = nHono ? Math.round(nHono.rps).toLocaleString() : "-";
      const hbo = bHono ? Math.round(bHono.rps).toLocaleString() : "-";
      const mSpeed =
        nMino && bMino && nMino.rps > 0 ? `(${(bMino.rps / nMino.rps).toFixed(2)}×)` : "";
      const hSpeed =
        nHono && bHono && nHono.rps > 0 ? `(${(bHono.rps / nHono.rps).toFixed(2)}×)` : "";
      return `<tr class="hover:bg-zinc-800/50"><td class="px-4 py-2 font-semibold">${label}</td><td class="px-3 py-2 text-right text-indigo-300">${mno}</td><td class="px-3 py-2 text-right text-indigo-400 font-bold">${mbo} <span class="text-zinc-500">${mSpeed}</span></td><td class="px-3 py-2 text-right text-amber-300">${hno}</td><td class="px-3 py-2 text-right text-amber-400 font-bold">${hbo} <span class="text-zinc-500">${hSpeed}</span></td></tr>`;
    })
    .join("\n");
}

function main() {
  const node = load("latest-node.json");
  const bun = load("latest-bun.json");
  if (!node && !bun) {
    console.error("No data: run bench:sequential (Node) and bench:bun:sequential (Bun) first");
    process.exit(1);
  }
  const now = new Date().toISOString();
  const nodeLabels = node ? labelsFor(node.results) : [];
  const bunLabels = bun ? labelsFor(bun.results) : [];
  const nodeFw = node ? frameworksFor(node.results) : [];
  const bunFw = bun ? frameworksFor(bun.results) : [];
  const nodeRps = node ? rpsDatasets(node.results, nodeLabels, nodeFw) : [];
  const nodeP95 = node ? p95Datasets(node.results, nodeLabels, nodeFw) : [];
  const bunRps = bun ? rpsDatasets(bun.results, bunLabels, bunFw) : [];
  const bunP95 = bun ? p95Datasets(bun.results, bunLabels, bunFw) : [];

  const nodeSys = (node?.system ?? {}) as {
    runtime?: string;
    node?: string;
    cpu?: string;
    cores?: number;
    platform?: string;
    ram?: string;
    os?: string;
  };
  const bunSys = (bun?.system ?? {}) as { runtime?: string; node?: string };
  const versions = { ...(node?.versions ?? {}), ...(bun?.versions ?? {}) };
  const nodeCount = node?.results.length ?? 0;
  const bunCount = bun?.results.length ?? 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MinoStack Benchmark — Node (3) + Bun (2) Combined</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;600;700&display=swap');
  body { font-family: Inter, sans-serif; }
  .mono { font-family: 'JetBrains Mono', monospace; }
  html { scroll-behavior: smooth; }
</style>
</head>
<body class="bg-[#0a0a0f] text-zinc-100 min-h-screen">
<div class="max-w-[1400px] mx-auto px-6 py-8">
<div class="relative overflow-hidden rounded-[28px] bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 p-[1.5px] shadow-2xl shadow-indigo-500/20">
<div class="rounded-[26px] bg-zinc-950 p-6 md:p-8">
<div class="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-indigo-500/20 to-fuchsia-500/20 border border-white/10 px-3 py-1.5 text-[11px] font-bold tracking-[0.14em] text-white/90"><span class="h-2 w-2 animate-pulse rounded-full bg-emerald-400"></span>MINOSTACK BENCHMARK • COMBINED • ${now.split("T")[0]}</div>
<h1 class="mt-4 text-[30px] md:text-[42px] font-[800] tracking-[-0.03em] leading-none">Mino <span class="bg-gradient-to-r from-indigo-400 to-fuchsia-400 bg-clip-text text-transparent">vs</span> Hono <span class="text-white/40">vs</span> Express <span class="text-white/60">v5</span> <span class="text-lg text-zinc-400 font-semibold">— Node + Bun</span></h1>
<p class="mt-3 max-w-3xl text-[14px] leading-relaxed text-zinc-400">Combined report — <span class="text-zinc-200 font-semibold">Node.js: Express vs Hono vs Mino (3 frameworks)</span> + <span class="text-zinc-200 font-semibold">Bun: Hono vs Mino (2, Express skipped)</span>. Fetch micro-benchmark <span class="text-zinc-200">performance.now()</span> in-process, sequential <span class="font-mono text-xs bg-zinc-800 px-1.5 py-0.5 rounded">scenario → workload → framework</span>. Per-runtime files preserved: <span class="mono text-xs">latest-node.json / latest-bun.json / report-node.html / report-bun.html</span>.</p>
<div class="mt-4 flex flex-wrap gap-2 text-xs">
<span class="rounded-full bg-emerald-500/20 px-3 py-1 font-mono text-emerald-300">node ${nodeSys.node ?? "-"} • ${nodeCount} runs • ${nodeFw.join(" / ") || "-"}</span>
<span class="rounded-full bg-amber-500/20 px-3 py-1 font-mono text-amber-300">bun ${bunSys.node ?? "-"} • ${bunCount} runs • ${bunFw.join(" / ") || "-"}</span>
<span class="rounded-full bg-zinc-800 px-3 py-1 font-mono">${nodeSys.cpu ?? ""} ×${nodeSys.cores ?? ""}</span>
<span class="rounded-full bg-zinc-800 px-3 py-1 font-mono">${now}</span>
</div>
<div class="mt-4 flex flex-wrap gap-2 text-xs font-bold">
<a href="#node" class="rounded-full bg-emerald-500 px-4 py-2 text-zinc-950">Node.js — 3 frameworks ↓</a>
<a href="#bun" class="rounded-full bg-amber-500 px-4 py-2 text-zinc-950">Bun — 2 frameworks ↓</a>
<a href="#crossover" class="rounded-full bg-white px-4 py-2 text-zinc-900">Node vs Bun crossover ↓</a>
</div>
<div class="mt-4 rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-3 text-xs text-zinc-400">Versions: <span class="mono">${Object.entries(
    versions,
  )
    .map(([k, v]) => `${k} ${v}`)
    .join(" • ")}</span></div>
<div class="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
<div class="rounded-2xl bg-zinc-900 p-4"><div class="text-xs text-zinc-500">Node runs</div><div class="mt-1 text-2xl font-bold text-emerald-300">${nodeCount}</div><div class="text-xs text-zinc-500">${node ? `${nodeLabels.length} scenarios • ${nodeFw.length} fw` : "missing — run bench:sequential"}</div></div>
<div class="rounded-2xl bg-zinc-900 p-4"><div class="text-xs text-zinc-500">Bun runs</div><div class="mt-1 text-2xl font-bold text-amber-300">${bunCount}</div><div class="text-xs text-zinc-500">${bun ? `${bunLabels.length} scenarios • ${bunFw.length} fw` : "missing — run bench:bun:sequential"}</div></div>
<div class="rounded-2xl bg-zinc-900 p-4"><div class="text-xs text-zinc-500">Node fastest (avg)</div><div class="mt-1 text-xl font-bold">${node ? fastestAvg(node.results, nodeFw) : "-"}</div><div class="text-xs text-zinc-500">moderate workload</div></div>
<div class="rounded-2xl bg-zinc-900 p-4"><div class="text-xs text-zinc-500">Bun fastest (avg)</div><div class="mt-1 text-xl font-bold">${bun ? fastestAvg(bun.results, bunFw) : "-"}</div><div class="text-xs text-zinc-500">moderate workload</div></div>
</div>
</div>
</div>

<div id="node" class="mt-8 rounded-[20px] bg-zinc-900 p-6 border border-emerald-500/20">
<div class="flex items-center justify-between flex-wrap gap-2"><h2 class="text-sm font-bold tracking-widest text-emerald-300">NODE.JS — EXPRESS vs HONO vs MINO (${nodeCount} runs)</h2><span class="mono text-xs text-zinc-500">${node?.timestamp ?? "-"} • ${nodeSys.node ?? ""}</span></div>
<p class="mt-1 text-xs text-zinc-500">Only runtime where all three can be compared (Express is Node-only). Higher Req/s better, lower p95 better.</p>
<div class="mt-4 grid gap-6 lg:grid-cols-2">
<div><h3 class="text-xs font-bold text-zinc-400">THROUGHPUT — Req/s (moderate)</h3><div class="mt-2 h-[320px]"><canvas id="rpsNodeChart"></canvas></div></div>
<div><h3 class="text-xs font-bold text-zinc-400">LATENCY — p95 ms (moderate)</h3><div class="mt-2 h-[320px]"><canvas id="latNodeChart"></canvas></div></div>
</div>
<div class="mt-4 overflow-auto rounded-xl border border-zinc-800"><table class="min-w-full text-left text-sm"><thead class="bg-zinc-950 text-xs uppercase tracking-widest text-zinc-500"><tr><th class="px-4 py-3">Scenario</th><th class="px-3 py-3">Workload</th><th class="px-3 py-3">Framework</th><th class="px-3 py-3 text-right">Req/s</th><th class="px-3 py-3 text-right">Avg ms</th><th class="px-3 py-3 text-right">p50</th><th class="px-3 py-3 text-right">p95</th><th class="px-3 py-3 text-right">p99</th><th class="px-3 py-3 text-right">Err%</th><th class="px-3 py-3 text-right">Heap MB</th></tr></thead><tbody class="divide-y divide-zinc-800 mono text-xs">${node ? rowsHtml(node.results) : ""}</tbody></table></div>
<div class="mt-3 text-xs text-zinc-500">Full detail: <a class="underline" href="report-node.html">report-node.html</a> • <a class="underline" href="latest-node.json">latest-node.json</a> • <a class="underline" href="latest-node.csv">latest-node.csv</a></div>
</div>

<div id="bun" class="mt-8 rounded-[20px] bg-zinc-900 p-6 border border-amber-500/20">
<div class="flex items-center justify-between flex-wrap gap-2"><h2 class="text-sm font-bold tracking-widest text-amber-300">BUN — HONO vs MINO (${bunCount} runs, Express skipped)</h2><span class="mono text-xs text-zinc-500">${bun?.timestamp ?? "-"} • ${bunSys.node ?? ""}</span></div>
<p class="mt-1 text-xs text-zinc-500">Fetch-native only — Express auto-skipped (runtime !== node). Bun is ~1.5–2× faster than Node on same hardware.</p>
<div class="mt-4 grid gap-6 lg:grid-cols-2">
<div><h3 class="text-xs font-bold text-zinc-400">THROUGHPUT — Req/s (moderate)</h3><div class="mt-2 h-[320px]"><canvas id="rpsBunChart"></canvas></div></div>
<div><h3 class="text-xs font-bold text-zinc-400">LATENCY — p95 ms (moderate)</h3><div class="mt-2 h-[320px]"><canvas id="latBunChart"></canvas></div></div>
</div>
<div class="mt-4 overflow-auto rounded-xl border border-zinc-800"><table class="min-w-full text-left text-sm"><thead class="bg-zinc-950 text-xs uppercase tracking-widest text-zinc-500"><tr><th class="px-4 py-3">Scenario</th><th class="px-3 py-3">Workload</th><th class="px-3 py-3">Framework</th><th class="px-3 py-3 text-right">Req/s</th><th class="px-3 py-3 text-right">Avg ms</th><th class="px-3 py-3 text-right">p50</th><th class="px-3 py-3 text-right">p95</th><th class="px-3 py-3 text-right">p99</th><th class="px-3 py-3 text-right">Err%</th><th class="px-3 py-3 text-right">Heap MB</th></tr></thead><tbody class="divide-y divide-zinc-800 mono text-xs">${bun ? rowsHtml(bun.results) : ""}</tbody></table></div>
<div class="mt-3 text-xs text-zinc-500">Full detail: <a class="underline" href="report-bun.html">report-bun.html</a> • <a class="underline" href="latest-bun.json">latest-bun.json</a> • <a class="underline" href="latest-bun.csv">latest-bun.csv</a></div>
</div>

<div id="crossover" class="mt-8 rounded-[20px] bg-zinc-900 p-6">
<h2 class="text-sm font-bold tracking-widest text-zinc-400">CROSSOVER — NODE vs BUN (moderate Req/s, higher better)</h2>
<p class="mt-1 text-xs text-zinc-500">Same scenarios, same machine — Bun speedup in parentheses.</p>
<div class="mt-4 overflow-auto rounded-xl border border-zinc-800"><table class="min-w-full text-left text-sm"><thead class="bg-zinc-950 text-xs uppercase tracking-widest text-zinc-500"><tr><th class="px-4 py-3">Scenario</th><th class="px-3 py-3 text-right">Mino Node</th><th class="px-3 py-3 text-right">Mino Bun</th><th class="px-3 py-3 text-right">Hono Node</th><th class="px-3 py-3 text-right">Hono Bun</th></tr></thead><tbody class="divide-y divide-zinc-800 mono text-xs">${crossoverRows(node, bun)}</tbody></table></div>
<div class="mt-6 flex gap-3 flex-wrap"><a href="latest-node.json" class="rounded-full bg-emerald-500 px-4 py-2 text-xs font-bold text-zinc-950">Node JSON</a><a href="latest-bun.json" class="rounded-full bg-amber-500 px-4 py-2 text-xs font-bold text-zinc-950">Bun JSON</a><a href="report-node.html" class="rounded-full bg-zinc-800 px-4 py-2 text-xs font-bold">Node report</a><a href="report-bun.html" class="rounded-full bg-zinc-800 px-4 py-2 text-xs font-bold">Bun report</a><span class="mono flex items-center text-xs text-zinc-500">data/latest-node.json • data/latest-bun.json • data/history/</span></div>
</div>
<div class="py-8 text-center text-xs text-zinc-600">Generated by @minostack/benchmark • Combined Node + Bun • ${now}</div>
</div>
<script>
const nodeLabels = __NODE_LABELS__;
const nodeRps = __NODE_RPS__;
const nodeP95 = __NODE_P95__;
const bunLabels = __BUN_LABELS__;
const bunRps = __BUN_RPS__;
const bunP95 = __BUN_P95__;
function mk(id, labels, datasets) { const el = document.getElementById(id); if (!el || labels.length === 0) return; new Chart(el, { type: 'bar', data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#a1a1aa' } } }, scales: { x: { ticks: { color: '#71717a' }, grid: { color: '#27272a' } }, y: { ticks: { color: '#71717a' }, grid: { color: '#27272a' }, beginAtZero: true } } } }); }
mk('rpsNodeChart', nodeLabels, nodeRps);
mk('latNodeChart', nodeLabels, nodeP95);
mk('rpsBunChart', bunLabels, bunRps);
mk('latBunChart', bunLabels, bunP95);
</script>
</body>
</html>`;

  const filled = html
    .replace("__NODE_LABELS__", JSON.stringify(nodeLabels))
    .replace("__NODE_RPS__", JSON.stringify(nodeRps))
    .replace("__NODE_P95__", JSON.stringify(nodeP95))
    .replace("__BUN_LABELS__", JSON.stringify(bunLabels))
    .replace("__BUN_RPS__", JSON.stringify(bunRps))
    .replace("__BUN_P95__", JSON.stringify(bunP95));

  const out = path.join(dataDir, "report.html");
  fs.writeFileSync(out, filled);
  console.log(`Combined report: ${out}`);
  console.log(`  Node: ${nodeCount} runs (${nodeFw.join("/") || "-"}) ${node?.timestamp ?? ""}`);
  console.log(`  Bun: ${bunCount} runs (${bunFw.join("/") || "-"}) ${bun?.timestamp ?? ""}`);
  console.log(
    `  Per-runtime kept: report-node.html, report-bun.html, latest-node.json, latest-bun.json`,
  );
}

main();
