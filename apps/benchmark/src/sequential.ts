/**
 * Sequential All Benchmark Runner — runs fetch + network sequentially and saves combined report
 * Saves to data/sequential-latest.json + data/report.html (visual)
 *
 * Run:
 *   pnpm --filter @minostack/benchmark bench:sequential
 *   pnpm --filter @minostack/benchmark bench:sequential -- --quick   # quick (mino static only)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "../data");
const historyDir = path.join(dataDir, "history");

function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      const s = String(d);
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr?.on("data", (d) => {
      const s = String(d);
      stderr += s;
      process.stderr.write(s);
    });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const isQuick = args.includes("--quick");
  const timestamp = new Date().toISOString();
  const tsFile = timestamp.replace(/[:.]/g, "-");

  console.log("== Sequential All Benchmark Runner ==");
  console.log(`Timestamp: ${timestamp}`);
  console.log(
    `Mode: ${isQuick ? "quick (mino static only)" : "full (all frameworks × all scenarios)"}`,
  );
  console.log("");

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });

  const results: Array<{ phase: string; code: number; durationMs: number }> = [];

  // Phase 1: Fetch micro-benchmark (sequential, in-process) — Mino vs Hono (Bun) + Express (Node only)
  const isBun =
    !!(process.versions as unknown as { bun?: string })?.bun ||
    !!(globalThis as unknown as { Bun?: unknown }).Bun;
  const runner = isBun ? "bun" : "tsx";
  console.log("┌─────────────────────────────────────────────────────┐");
  console.log(
    `│ Phase 1/2: Fetch micro-benchmark (Mino/Hono${isBun ? " on Bun" : "/Express on Node"}) │`,
  );
  console.log("└─────────────────────────────────────────────────────┘");
  const t1 = Date.now();
  const indexPath = path.join(__dirname, "index.ts");
  // Quick = all frameworks but static only (Node: 3, Bun: 2) for fast yet comparative
  const fetchArgs = isQuick
    ? isBun
      ? ["run", indexPath, "--", "--framework=all", "--scenario=static"]
      : [indexPath, "--", "--framework=all", "--scenario=static"]
    : isBun
      ? ["run", indexPath]
      : [indexPath];
  // Use NODE_OPTIONS=--expose-gc for more accurate heap (Node only; Bun has its own GC)
  const fetchRes = await run(
    runner,
    fetchArgs,
    isBun ? {} : { env: { NODE_OPTIONS: "--expose-gc" } },
  );
  const d1 = Date.now() - t1;
  results.push({ phase: "fetch", code: fetchRes.code, durationMs: d1 });
  if (fetchRes.code !== 0)
    console.warn(
      `Fetch benchmark exited with code ${fetchRes.code} (may have OOM on large matrix, but data still saved if available)`,
    );

  // Phase 2: Network benchmark (autocannon) — Node only (Express), Bun uses fetch only
  console.log("");
  console.log("┌─────────────────────────────────────────────────────┐");
  console.log("│ Phase 2/2: Network benchmark (autocannon, Node)     │");
  console.log("└─────────────────────────────────────────────────────┘");
  const t2 = Date.now();
  let netRes: { code: number; stdout: string; stderr: string } = {
    code: 0,
    stdout: "",
    stderr: "",
  };
  if (isBun) {
    console.log(
      "Skipping network (autocannon is Node-only) on Bun — fetch micro-benchmark is primary for Bun (Mino vs Hono).",
    );
    console.log(
      "For Bun network, use `bun run src/index.ts` (fetch) — Bun.serve is used internally for Mino/Hono.",
    );
  } else {
    const networkPath = path.join(__dirname, "network.ts");
    const netArgs = isQuick
      ? [networkPath, "--", "--connections=10", "--duration=2"]
      : [networkPath, "--", "--connections=10", "--duration=5"];
    netRes = await run("tsx", netArgs);
  }
  const d2 = Date.now() - t2;
  results.push({ phase: "network", code: netRes.code, durationMs: d2 });
  if (netRes.code !== 0)
    console.warn(
      `Network benchmark exited with code ${netRes.code} (autocannon may not be available on this runtime)`,
    );

  // Collect latest data files
  const latestJson = path.join(dataDir, "latest.json");
  const latestCsv = path.join(dataDir, "latest.csv");
  const reportHtml = path.join(dataDir, "report.html");
  const hasFetchData = fs.existsSync(latestJson);
  const hasReport = fs.existsSync(reportHtml);

  // Create combined sequential report
  const sequentialReport = {
    timestamp,
    mode: isQuick ? "quick" : "full",
    phases: results,
    system: {
      platform: `${process.platform} ${process.arch}`,
      node: process.version,
      runtime: (globalThis as unknown as { Bun?: unknown; Deno?: unknown }).Bun
        ? "bun"
        : (globalThis as unknown as { Deno?: unknown }).Deno
          ? "deno"
          : "node",
    },
    artifacts: {
      fetchJson: hasFetchData ? "data/latest.json" : null,
      fetchCsv: fs.existsSync(latestCsv) ? "data/latest.csv" : null,
      fetchHtml: hasReport ? "data/report.html" : null,
      networkJson: null as string | null,
    },
    note: "Sequential runner executed fetch + network phases in order. Fetch data is in data/latest.json + visual at data/report.html. Network data is logged to console (autocannon). For history, see data/history/",
  };

  const runtime = (globalThis as unknown as { Bun?: unknown; Deno?: unknown }).Bun
    ? "bun"
    : (globalThis as unknown as { Deno?: unknown }).Deno
      ? "deno"
      : "node";
  const seqPath = path.join(dataDir, "sequential-latest.json");
  const seqRuntimePath = path.join(dataDir, `sequential-latest-${runtime}.json`);
  const seqHistoryPath = path.join(historyDir, `sequential-${tsFile}.json`);
  const seqHistoryRuntimePath = path.join(historyDir, `sequential-${runtime}-${tsFile}.json`);
  fs.writeFileSync(seqPath, JSON.stringify(sequentialReport, null, 2));
  fs.writeFileSync(seqRuntimePath, JSON.stringify(sequentialReport, null, 2));
  fs.writeFileSync(seqHistoryPath, JSON.stringify(sequentialReport, null, 2));
  fs.writeFileSync(seqHistoryRuntimePath, JSON.stringify(sequentialReport, null, 2));

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("✅ Sequential run complete");
  console.log(
    `   Duration: ${((d1 + d2) / 1000).toFixed(1)}s (fetch ${(d1 / 1000).toFixed(1)}s + network ${(d2 / 1000).toFixed(1)}s)`,
  );
  console.log(
    `   Fetch data: ${hasFetchData ? latestJson : "no data (fetch may have OOM, try --quick)"}`,
  );
  console.log(`   Visual: ${hasReport ? reportHtml + " (open in browser)" : "no report"}`);
  console.log(`   CSV: ${latestCsv}`);
  console.log(`   Sequential report: ${seqPath} (also ${seqRuntimePath})`);
  console.log(`   History: ${seqHistoryPath} (also ${seqHistoryRuntimePath})`);
  console.log("");
  console.log(
    "Visual: open data/report.html in browser for interactive charts (Chart.js + Tailwind)",
  );
  console.log("Data: data/latest.json (JSON) + data/latest.csv (CSV) for custom visualization");
  console.log("History: data/history/ for trend analysis");
  console.log("═══════════════════════════════════════════════════════════");
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith("sequential.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
