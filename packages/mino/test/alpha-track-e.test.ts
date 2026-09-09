/**
 * alpha-track-e: streamed static bodies + `logger` sub-path split.
 *
 * - A streamed (non-`Uint8Array`) loader body flows through `serveStatic`
 *   with a 200 and exact bytes.
 * - `logger` (+ `AccessLogEntry` / `LoggerOptions`) is importable from
 *   `../src/logger.js` with identical behavior, and the `request-id`
 *   re-export is the same function (api-freeze surface unchanged).
 */
import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { serveStatic } from "../src/static.js";
import { logger } from "../src/logger.js";
import { logger as loggerFromRequestId } from "../src/request-id.js";
import type { AccessLogEntry } from "../src/logger.js";

function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

describe("track E: streamed static body", () => {
  it("serves a ReadableStream loader entry with 200 and exact bytes", async () => {
    const payload = new TextEncoder().encode("streamed-bytes-0123456789");
    const app = new Mino();
    app.use(
      serveStatic({
        loader: {
          load: async (p: string) =>
            p === "live.bin"
              ? {
                  body: new ReadableStream<Uint8Array>({
                    start(c) {
                      c.enqueue(payload);
                      c.close();
                    },
                  }) as unknown as BodyInit,
                  type: "application/octet-stream",
                  size: payload.byteLength,
                }
              : undefined,
        },
      }),
    );
    const res = await fetchVia(app, "/static/live.bin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(payload.byteLength));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
  });
});

describe("track E: logger sub-path", () => {
  it("request-id re-exports the same logger function", () => {
    expect(loggerFromRequestId).toBe(logger);
  });

  it("logs access entries with the documented shape via a custom sink", async () => {
    const seen: AccessLogEntry[] = [];
    const app = new Mino();
    app.use(logger({ log: (e) => seen.push(e) }));
    app.get("/things/:id", (c) => c.json({ id: c.param("id") }));
    const res = await fetchVia(app, "/things/7");
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    const [entry] = seen;
    expect(entry?.method).toBe("GET");
    expect(entry?.path).toBe("/things/7");
    expect(entry?.route).toBe("/things/:id");
    expect(entry?.status).toBe(200);
    expect(typeof entry?.ms).toBe("number");
    expect(typeof entry?.time).toBe("string");
  });
});
