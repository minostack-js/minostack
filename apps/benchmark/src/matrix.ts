/**
 * Real-socket benchmark matrix (Phase D2) — autocannon over 127.0.0.1.
 *
 * All 11 scenarios × {mino, hono, express, fastify} × N runs (median), Node 22 + 24,
 * plus a 60s sustained run + post-GC heap/RSS columns.
 *
 * This is the AUTHORITATIVE apples-to-apples comparison: every framework
 * serves over a real listening socket (mino via @minostack/runtime-node,
 * hono via node:http + toRequest/toNodeResponse, express/fastify via app.listen).
 * The fetch micro-benchmark in src/index.ts drives Express through a mocked
 * req/res wrapper (Fastify uses app.inject there) — do NOT cite fetch-bench
 * Express deltas as throughput wins.
 *
 * Run:
 *   pnpm --filter @minostack/benchmark bench:matrix         # full matrix (3 runs × 5s + 60s sustained)
 *   pnpm --filter @minostack/benchmark bench:matrix:quick   # smoke (1 run × 2s, static only)
 *   NODE_OPTIONS=--expose-gc pnpm --filter @minostack/benchmark bench:matrix  # + post-GC memory
 *
 * Artifacts: data/matrix-<node>.json + data/matrix-<node>.csv + history/
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "../data");
const historyDir = path.join(dataDir, "history");

type Framework = "mino" | "hono" | "express" | "fastify";

const SCENARIOS = [
  "static",
  "param",
  "multi-param",
  "wildcard",
  "deep-nested",
  "middleware-1",
  "middleware-5",
  "middleware-10",
  "small-json",
  "text",
  "large-json",
] as const;

type Scenario = (typeof SCENARIOS)[number];

const PATHS: Record<Scenario, string> = {
  static: "/hello",
  param: "/users/123",
  "multi-param": "/users/1/books/2",
  wildcard: "/files/a/b/c",
  "deep-nested": "/a/b/c/d/e/123",
  "middleware-1": "/",
  "middleware-5": "/",
  "middleware-10": "/",
  "small-json": "/json",
  text: "/text",
  "large-json": "/large",
};

type ServerHandle = { url: string; close: () => Promise<void> };

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function postGcMemory(): { heapUsedMB: number; rssMB: number } {
  try {
    (globalThis as { gc?: () => void }).gc?.();
  } catch {
    /* expose-gc not enabled — raw numbers */
  }
  const m = process.memoryUsage();
  return { heapUsedMB: m.heapUsed / 1024 / 1024, rssMB: m.rss / 1024 / 1024 };
}

// ─────────────────────────────────────────────────────────────────
// Server factories — real listening sockets, equivalent routes
// ─────────────────────────────────────────────────────────────────

async function serveMino(scenario: Scenario): Promise<ServerHandle> {
  const { Mino } = await import("@minostack/mino");
  const { serve } = await import("@minostack/runtime-node");
  // @ts-ignore — workspace lib, loosely typed here
  const app = new Mino();
  const large = {
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `Name ${i}`,
      value: "x".repeat(100),
    })),
  };
  switch (scenario) {
    case "static":
      app.get("/hello", (c) => c.text("hi"));
      break;
    case "param":
      app.get("/users/:id", (c) => c.json({ id: c.param("id") }));
      break;
    case "multi-param":
      app.get("/users/:id/books/:bookId", (c) => c.json(c.params));
      break;
    case "wildcard":
      app.get("/files/*", (c) => c.text((c.params as Record<string, string>).wildcard ?? ""));
      break;
    case "deep-nested":
      app.get("/a/b/c/d/e/:id", (c) => c.json({ id: c.param("id") }));
      break;
    case "middleware-1":
    case "middleware-5":
    case "middleware-10": {
      const n = scenario === "middleware-1" ? 1 : scenario === "middleware-5" ? 5 : 10;
      for (let i = 0; i < n; i++) app.use(async (_c, next) => void (await next()));
      app.get("/", (c) => c.text("ok"));
      break;
    }
    case "small-json":
      app.get("/json", (c) => c.json({ ok: true, id: 1 }));
      break;
    case "text":
      app.get("/text", (c) => c.text("hello world ".repeat(10)));
      break;
    case "large-json":
      app.get("/large", (c) => c.json(large));
      break;
  }
  const server = serve(app as unknown as { fetch: (r: Request) => Promise<Response> }, {
    port: 0,
    hostname: "127.0.0.1",
  });
  await new Promise<void>((res) => server.on("listening", () => res()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}${PATHS[scenario]}`,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

async function serveHono(scenario: Scenario): Promise<ServerHandle> {
  const { Hono } = await import("hono");
  const { createServer } = await import("node:http");
  const { toRequest, toNodeResponse } = await import("@minostack/runtime-node");
  // @ts-ignore
  const app = new Hono();
  const large = {
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `Name ${i}`,
      value: "x".repeat(100),
    })),
  };
  switch (scenario) {
    case "static":
      app.get("/hello", (c) => c.text("hi"));
      break;
    case "param":
      app.get("/users/:id", (c) => c.json({ id: c.req.param("id") }));
      break;
    case "multi-param":
      app.get("/users/:id/books/:bookId", (c) =>
        // @ts-ignore
        c.json({ id: c.req.param("id"), bookId: c.req.param("bookId") }),
      );
      break;
    case "wildcard":
      app.get("/files/*", (c) => c.text(c.req.param("*") ?? ""));
      break;
    case "deep-nested":
      app.get("/a/b/c/d/e/:id", (c) => c.json({ id: c.req.param("id") }));
      break;
    case "middleware-1":
    case "middleware-5":
    case "middleware-10": {
      const n = scenario === "middleware-1" ? 1 : scenario === "middleware-5" ? 5 : 10;
      for (let i = 0; i < n; i++) app.use(async (_c, next) => void (await next()));
      app.get("/", (c) => c.text("ok"));
      break;
    }
    case "small-json":
      app.get("/json", (c) => c.json({ ok: true, id: 1 }));
      break;
    case "text":
      app.get("/text", (c) => c.text("hello world ".repeat(10)));
      break;
    case "large-json":
      app.get("/large", (c) => c.json(large));
      break;
  }
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    // @ts-ignore
    const fetchReq = toRequest(req, { host });
    const fetchRes = await (app as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
      fetchReq,
    );
    // @ts-ignore
    await toNodeResponse(fetchRes, res);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}${PATHS[scenario]}`,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

type ExpressTestReq = { params: Record<string, string> };
type ExpressTestRes = { send: (b: string) => unknown; json: (o: unknown) => unknown };
type ExpressTestApp = {
  get: (p: string, h: (req: ExpressTestReq, res: ExpressTestRes) => void) => void;
  use: (h: (req: ExpressTestReq, res: ExpressTestRes, next: () => void) => void) => void;
  listen: (
    port: number,
    host: string,
    cb: () => void,
  ) => { address: () => { port: number }; close: (cb: (e?: Error) => void) => void };
};

async function serveExpress(scenario: Scenario): Promise<ServerHandle> {
  const expressMod = await import("express").then((m) => (m as { default: unknown }).default ?? m);
  const app = (expressMod as unknown as () => ExpressTestApp)();
  const large = {
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `Name ${i}`,
      value: "x".repeat(100),
    })),
  };
  const mw = (_req: ExpressTestReq, _res: ExpressTestRes, next: () => void): void => next();
  switch (scenario) {
    case "static":
      app.get("/hello", (_req, res) => res.send("hi"));
      break;
    case "param":
      app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
      break;
    case "multi-param":
      app.get("/users/:id/books/:bookId", (req, res) => res.json(req.params));
      break;
    case "wildcard":
      app.get("/files/*splat", (_req, res) => res.send("wildcard"));
      break;
    case "deep-nested":
      app.get("/a/b/c/d/e/:id", (req, res) => res.json({ id: req.params.id }));
      break;
    case "middleware-1":
    case "middleware-5":
    case "middleware-10": {
      const n = scenario === "middleware-1" ? 1 : scenario === "middleware-5" ? 5 : 10;
      for (let i = 0; i < n; i++) app.use(mw);
      app.get("/", (_req, res) => res.send("ok"));
      break;
    }
    case "small-json":
      app.get("/json", (_req, res) => res.json({ ok: true, id: 1 }));
      break;
    case "text":
      app.get("/text", (_req, res) => res.send("hello world ".repeat(10)));
      break;
    case "large-json":
      app.get("/large", (_req, res) => res.json(large));
      break;
  }
  const server = app.listen(0, "127.0.0.1", () => {});
  await new Promise<void>((res) => setTimeout(res, 50));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}${PATHS[scenario]}`,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

async function serveFastify(scenario: Scenario): Promise<ServerHandle> {
  const fastifyMod = await import("fastify").then((m) => (m as { default: unknown }).default ?? m);
  const app = (
    fastifyMod as unknown as (opts: { logger: boolean }) => {
      get: (
        p: string,
        h: (req: { params: Record<string, string> }, reply: { send: (b: unknown) => void }) => void,
      ) => void;
      addHook: (name: string, h: () => Promise<void> | void) => void;
      listen: (opts: { port: number; host: string }) => Promise<string>;
      server: { address: () => { port: number } };
      close: () => Promise<void>;
    }
  )({ logger: false });
  const large = {
    data: Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `Name ${i}`,
      value: "x".repeat(100),
    })),
  };
  switch (scenario) {
    case "static":
      app.get("/hello", (_req, reply) => reply.send("hi"));
      break;
    case "param":
      app.get("/users/:id", (req, reply) => reply.send({ id: req.params.id }));
      break;
    case "multi-param":
      app.get("/users/:id/books/:bookId", (req, reply) => reply.send(req.params));
      break;
    case "wildcard":
      app.get("/files/*", (_req, reply) => reply.send("wildcard"));
      break;
    case "deep-nested":
      app.get("/a/b/c/d/e/:id", (req, reply) => reply.send({ id: req.params.id }));
      break;
    case "middleware-1":
    case "middleware-5":
    case "middleware-10": {
      const n = scenario === "middleware-1" ? 1 : scenario === "middleware-5" ? 5 : 10;
      for (let i = 0; i < n; i++) app.addHook("onRequest", async () => {});
      app.get("/", (_req, reply) => reply.send("ok"));
      break;
    }
    case "small-json":
      app.get("/json", (_req, reply) => reply.send({ ok: true, id: 1 }));
      break;
    case "text":
      app.get("/text", (_req, reply) => reply.send("hello world ".repeat(10)));
      break;
    case "large-json":
      app.get("/large", (_req, reply) => reply.send(large));
      break;
  }
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  return {
    url: `http://127.0.0.1:${addr.port}${PATHS[scenario]}`,
    close: () => app.close().then(() => {}),
  };
}

const SERVERS: Record<Framework, (s: Scenario) => Promise<ServerHandle>> = {
  mino: serveMino,
  hono: serveHono,
  express: serveExpress,
  fastify: serveFastify,
};

// ─────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────

type CellResult = {
  scenario: string;
  framework: Framework;
  runs: number;
  rpsRuns: number[];
  rpsMedian: number;
  avgMs: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  timeouts: number;
  heapUsedMB: number;
  rssMB: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Autocannon = (opts: unknown) => Promise<any>;

async function benchOnce(
  autocannon: Autocannon,
  url: string,
  connections: number,
  duration: number,
): Promise<{
  rps: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  timeouts: number;
}> {
  const r = await autocannon({ url, connections, duration, pipelining: 1 });
  const avgRps: number = r.requests.average ?? r.requests.mean ?? 0;
  return {
    rps: avgRps,
    avg: r.latency.average ?? 0,
    p50: r.latency.p50 ?? r.latency.average ?? 0,
    p95: r.latency.p95 ?? r.latency.p97_5 ?? r.latency.p99 ?? r.latency.average ?? 0,
    p99: r.latency.p99 ?? r.latency.average ?? 0,
    errors: r.errors ?? 0,
    timeouts: r.timeouts ?? 0,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quick = args.includes("--quick");
  const num = (name: string, dflt: number): number => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.split("=")[1]) : dflt;
  };
  const runs = quick ? 1 : num("runs", 3);
  const duration = quick ? 2 : num("duration", 5);
  const sustainedSecs = quick ? 0 : num("sustained", 60);
  const connections = num("connections", 10);
  const onlyScenario = args.find((a) => a.startsWith("--scenario="))?.split("=")[1] as
    Scenario | undefined;
  const scenarios: Scenario[] = onlyScenario ? [onlyScenario] : quick ? ["static"] : [...SCENARIOS];
  const frameworks: Framework[] = ["mino", "hono", "express", "fastify"];

  // @ts-ignore — no types for autocannon
  const autocannonMod = await import("autocannon").then((m) => m.default ?? m);
  const autocannon = autocannonMod as Autocannon;

  const nodeVer = process.version;
  const timestamp = new Date().toISOString();
  console.log("== MinoStack Real-Socket Matrix (Phase D2, authoritative) ==");
  console.log(
    `Node: ${nodeVer} | CPU: ${os.cpus()[0]?.model} x${os.cpus().length} | ${os.platform()} ${os.arch()}`,
  );
  console.log(
    `Config: scenarios=${scenarios.length} frameworks=${frameworks.length} runs=${runs} duration=${duration}s connections=${connections} sustained=${sustainedSecs}s`,
  );
  console.log(`GC exposed: ${typeof (globalThis as { gc?: unknown }).gc === "function"}`);
  console.log("");

  const cells: CellResult[] = [];
  for (const scenario of scenarios) {
    for (const fw of frameworks) {
      const { url, close } = await SERVERS[fw](scenario);
      try {
        const rpsRuns: number[] = [];
        let agg = { avg: 0, p50: 0, p95: 0, p99: 0, errors: 0, timeouts: 0 };
        for (let i = 0; i < runs; i++) {
          const r = await benchOnce(autocannon, url, connections, duration);
          rpsRuns.push(r.rps);
          agg = r; // latencies/errors from last run; median applies to rps
        }
        await close();
        const mem = postGcMemory();
        const cell: CellResult = {
          scenario,
          framework: fw,
          runs,
          rpsRuns: rpsRuns.map(Math.round),
          rpsMedian: Math.round(median(rpsRuns)),
          avgMs: agg.avg,
          p50: agg.p50,
          p95: agg.p95,
          p99: agg.p99,
          errors: agg.errors,
          timeouts: agg.timeouts,
          heapUsedMB: Math.round(mem.heapUsedMB * 10) / 10,
          rssMB: Math.round(mem.rssMB * 10) / 10,
        };
        cells.push(cell);
        console.log(
          `${scenario.padEnd(14)} ${fw.padEnd(8)} rps(med)=${String(cell.rpsMedian).padStart(7)} [${cell.rpsRuns.join(",")}] p95=${cell.p95.toFixed(2)} heap=${cell.heapUsedMB}MB err=${cell.errors}`,
        );
      } catch (e) {
        await close().catch(() => {});
        throw e;
      }
    }
  }

  // Sustained run (static scaffold, all frameworks)
  const sustained: CellResult[] = [];
  if (sustainedSecs > 0) {
    console.log("");
    console.log(`-- Sustained ${sustainedSecs}s (static) --`);
    for (const fw of frameworks) {
      const { url, close } = await SERVERS[fw]("static");
      try {
        const r = await benchOnce(autocannon, url, connections, sustainedSecs);
        await close();
        const mem = postGcMemory();
        const cell: CellResult = {
          scenario: "sustained-static",
          framework: fw,
          runs: 1,
          rpsRuns: [Math.round(r.rps)],
          rpsMedian: Math.round(r.rps),
          avgMs: r.avg,
          p50: r.p50,
          p95: r.p95,
          p99: r.p99,
          errors: r.errors,
          timeouts: r.timeouts,
          heapUsedMB: Math.round(mem.heapUsedMB * 10) / 10,
          rssMB: Math.round(mem.rssMB * 10) / 10,
        };
        sustained.push(cell);
        console.log(
          `sustained       ${fw.padEnd(8)} rps=${String(cell.rpsMedian).padStart(7)} p95=${cell.p95.toFixed(2)} heap=${cell.heapUsedMB}MB err=${cell.errors}`,
        );
      } catch (e) {
        await close().catch(() => {});
        throw e;
      }
    }
  }

  // Verdict table: mino vs express per scenario (median rps + heap)
  console.log("");
  console.log("-- Verdict (mino vs express, median rps / post-GC heap) --");
  for (const scenario of scenarios) {
    const m = cells.find((c) => c.scenario === scenario && c.framework === "mino");
    const e = cells.find((c) => c.scenario === scenario && c.framework === "express");
    if (!m || !e) continue;
    const rpsWin = m.rpsMedian >= e.rpsMedian ? "mino≥express" : "express>mino";
    const heapWin = m.heapUsedMB <= e.heapUsedMB ? "mino≤express" : "express<mino";
    console.log(
      `${scenario.padEnd(14)} rps ${m.rpsMedian} vs ${e.rpsMedian} → ${rpsWin} | heap ${m.heapUsedMB}MB vs ${e.heapUsedMB}MB → ${heapWin}`,
    );
  }

  // Artifacts
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });
  const tag = `matrix-${nodeVer.replace(/^v/, "node")}`;
  const report = {
    timestamp,
    node: nodeVer,
    system: {
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      ram: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    },
    config: { runs, duration, connections, sustainedSecs, scenarios },
    cells,
    sustained,
    note: "Real sockets (autocannon). heapUsedMB/rssMB measured in the harness process after server close + gc() — includes harness overhead, comparable within a run only. Fetch micro-bench Express numbers (mocked req/res) are NOT comparable.",
  };
  const jsonPath = path.join(dataDir, `${tag}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const head =
    "node,scenario,framework,runs,rps_median,rps_runs,avg_ms,p50,p95,p99,errors,timeouts,heapUsedMB_postGC,rssMB_postGC";
  const rows = [...cells, ...sustained].map((c) =>
    [
      nodeVer,
      c.scenario,
      c.framework,
      c.runs,
      c.rpsMedian,
      `"${c.rpsRuns.join(";")}"`,
      c.avgMs.toFixed(2),
      c.p50.toFixed(2),
      c.p95.toFixed(2),
      c.p99.toFixed(2),
      c.errors,
      c.timeouts,
      c.heapUsedMB,
      c.rssMB,
    ].join(","),
  );
  const csvPath = path.join(dataDir, `${tag}.csv`);
  fs.writeFileSync(csvPath, [head, ...rows].join("\n"));
  const tsFile = timestamp.replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(historyDir, `${tag}-${tsFile}.json`), JSON.stringify(report, null, 2));
  console.log("");
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
}

const isDirect =
  import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith("matrix.ts");
if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
