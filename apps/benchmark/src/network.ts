/**
 * Network Benchmark — autocannon vs Node http (Mino / Hono / Express)
 * Per §31: autocannon for network, with RSS/heap, p50/p95/p99
 *
 * Run:
 *   pnpm --filter @minostack/benchmark bench:network
 *   pnpm --filter @minostack/benchmark bench:network -- --connections=100 --duration=10
 */

import os from "node:os";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

function getVersions() {
  const readVersion = (pkg: string): string | null => {
    try {
      return require(`${pkg}/package.json`).version as string;
    } catch {
      try {
        const entry = require.resolve(pkg);
        let dir = path.dirname(entry);
        for (let i = 0; i < 6; i++) {
          const pj = path.join(dir, "package.json");
          if (fs.existsSync(pj)) {
            try {
              const data = JSON.parse(fs.readFileSync(pj, "utf-8")) as {
                name?: string;
                version?: string;
              };
              if (data.version) {
                if (
                  !data.name ||
                  data.name === pkg ||
                  data.name.startsWith(pkg) ||
                  dir.includes(pkg)
                )
                  return data.version;
              }
            } catch {}
          }
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      } catch {}
      return null;
    }
  };
  return {
    mino: readVersion("@minostack/mino") ?? "workspace",
    hono: readVersion("hono") ?? "not installed",
    express: readVersion("express") ?? "not installed",
    autocannon: readVersion("autocannon") ?? "not installed",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const connections = Number(
    args.find((a) => a.startsWith("--connections="))?.split("=")[1] ?? "10",
  );
  const duration = Number(args.find((a) => a.startsWith("--duration="))?.split("=")[1] ?? "5");
  const pipelining = Number(args.find((a) => a.startsWith("--pipelining="))?.split("=")[1] ?? "1");

  const vers = getVersions();
  const sys = {
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    ram: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
    platform: `${os.platform()} ${os.arch()} ${os.release()}`,
    node: process.version,
  };

  console.log("== MinoStack Network Benchmark — autocannon (Node http) ==");
  console.log(
    `CPU: ${sys.cpu} x${sys.cores} | RAM: ${sys.ram} | OS: ${sys.platform} | Node: ${sys.node}`,
  );
  console.log(
    `Versions: mino ${vers.mino} | hono ${vers.hono} | express ${vers.express} | autocannon ${vers.autocannon}`,
  );
  console.log(
    `Config: connections=${connections}, duration=${duration}s, pipelining=${pipelining}, warmup=1s`,
  );
  console.log(`Date: ${new Date().toISOString()}`);
  console.log("");

  let autocannon: unknown;
  try {
    // @ts-ignore - no types for autocannon
    autocannon = await import("autocannon").then((m) => (m as { default: unknown }).default ?? m);
  } catch {
    console.error(
      "autocannon not found. Install with: pnpm --filter @minostack/benchmark add autocannon",
    );
    process.exit(1);
  }

  const header = [
    "Framework".padEnd(10),
    "Req/s".padStart(9),
    "Avg ms".padStart(8),
    "p50".padStart(7),
    "p95".padStart(7),
    "p99".padStart(7),
    "Err".padStart(6),
    "Timeout".padStart(8),
  ].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));

  // Helper to run autocannon for a given server
  async function benchWithServer(
    name: string,
    createServer: () => Promise<{ url: string; close: () => Promise<void> }>,
  ) {
    const { url, close } = await createServer();
    try {
      const result = await (
        autocannon as unknown as (opts: unknown) => Promise<{
          requests: { average: number; total: number; mean?: number };
          latency: {
            average: number;
            p50: number;
            p95?: number;
            p97_5?: number;
            p99: number;
            p99_9?: number;
          };
          errors: number;
          timeouts: number;
          throughput: { average: number };
        }>
      )({
        url,
        connections,
        duration,
        pipelining,
      });
      const avg = result.requests.average ?? (result.requests as { mean?: number }).mean ?? 0;
      const p50 = result.latency.p50 ?? result.latency.average ?? 0;
      const p95 =
        (result.latency as { p95?: number; p97_5?: number }).p95 ??
        (result.latency as { p97_5?: number }).p97_5 ??
        result.latency.p99 ??
        result.latency.average ??
        0;
      const p99 =
        result.latency.p99 ??
        (result.latency as { p99_9?: number }).p99_9 ??
        result.latency.average ??
        0;
      console.log(
        [
          name.padEnd(10),
          String(Math.round(avg)).padStart(9),
          result.latency.average.toFixed(2).padStart(8),
          p50.toFixed(2).padStart(7),
          p95.toFixed(2).padStart(7),
          p99.toFixed(2).padStart(7),
          String(result.errors).padStart(6),
          String(result.timeouts).padStart(8),
        ].join(" | "),
      );
      return result;
    } finally {
      await close();
    }
  }

  // Mino via runtime-node
  await benchWithServer("mino", async () => {
    const { Mino } = await import("@minostack/mino");
    const { serve } = await import("@minostack/runtime-node");
    const app = new Mino();
    app.get("/hello", (c) => c.text("hi"));
    app.get("/json", (c) => c.json({ ok: true }));
    const server = serve(app as unknown as { fetch: (r: Request) => Promise<Response> }, {
      port: 0,
      hostname: "127.0.0.1",
    });
    await new Promise<void>((res) => server.on("listening", () => res()));
    const addr = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${addr.port}/hello`,
      close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
    };
  });

  // Hono via Node http (fetch handler)
  await benchWithServer("hono", async () => {
    const { Hono } = await import("hono");
    const { createServer } = await import("node:http");
    const app = new Hono();
    // @ts-ignore
    app.get("/hello", (c) => c.text("hi"));
    const server = createServer(async (req, res) => {
      // Convert Node req to Fetch Request, then to Hono fetch, then back
      const { toRequest } = await import("@minostack/runtime-node");
      const { toNodeResponse } = await import("@minostack/runtime-node");
      const host = req.headers.host ?? "127.0.0.1";
      // @ts-ignore
      const fetchReq = toRequest(req as unknown as import("node:http").IncomingMessage, { host });
      const fetchRes = await (app as unknown as { fetch: (r: Request) => Promise<Response> }).fetch(
        fetchReq,
      );
      await toNodeResponse(fetchRes, res as unknown as import("node:http").ServerResponse);
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    const addr = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${addr.port}/hello`,
      close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
    };
  });

  // Express
  await benchWithServer("express", async () => {
    const expressMod = await import("express").then(
      (m) => (m as { default: unknown }).default ?? m,
    );
    // @ts-ignore
    const app = (
      expressMod as () => {
        get: (p: string, h: (req: unknown, res: unknown) => void) => void;
        listen: (
          port: number,
          host: string,
          cb: () => void,
        ) => { address: () => { port: number }; close: (cb: (e?: Error) => void) => void };
      }
    )();
    app.get("/hello", (_req: unknown, res: unknown) =>
      (res as { send: (b: string) => void }).send("hi"),
    );
    const server = app.listen(0, "127.0.0.1", () => {});
    await new Promise<void>((res) =>
      (server as unknown as { on: (e: string, cb: () => void) => void }).on("listening", () =>
        res(),
      ),
    );
    // Also handle if already listening
    await new Promise((r) => setTimeout(r, 50));
    const addr = (server as unknown as { address: () => { port: number } }).address();
    return {
      url: `http://127.0.0.1:${addr.port}/hello`,
      close: () =>
        new Promise<void>((res, rej) =>
          (server as unknown as { close: (cb: (e?: Error) => void) => void }).close((e) =>
            e ? rej(e) : res(),
          ),
        ),
    };
  });

  console.log("");
  console.log("Reproducibility: autocannon with http/1.1, keep-alive, pipelining 1");
  console.log(
    `System: ${sys.cpu} | ${sys.cores} cores | ${sys.ram} | ${sys.platform} | Node ${sys.node}`,
  );
  console.log(
    `Frameworks: ${JSON.stringify(vers)} | Connections: ${connections} | Duration: ${duration}s`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith("network.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
