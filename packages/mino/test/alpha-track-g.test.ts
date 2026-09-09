/**
 * alpha-track-g: multipart/byteranges + If-Range in serveStatic.
 *
 * Hermetic — all in-process via `app.fetch`. No external network, no
 * filesystem, no secrets in logs.
 *
 * Precedence (RFC 9110, documented in `static.ts`):
 * `If-None-Match` / `If-Modified-Since` FIRST (304 wins) → `If-Range`
 * (stale → 200 full, never multipart/416) → `Range`.
 */
import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { serveStatic, type StaticLoader } from "../src/static.js";
import { parseRangeList } from "../src/file.js";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(req(path, init));
}

function bytesLoader(): StaticLoader {
  const full = new TextEncoder().encode("0123456789");
  const files = new Map<string, Uint8Array>([["data.bin", full]]);
  return {
    load: async (p: string) => {
      const body = files.get(p);
      if (!body) return undefined;
      return { body, type: "application/octet-stream", size: body.byteLength };
    },
  };
}

const MTIME = new Date("2024-01-01T00:00:00Z");

function mtimeLoader(): StaticLoader {
  const full = new TextEncoder().encode("0123456789");
  return {
    load: async (p: string) =>
      p === "data.bin"
        ? { body: full, type: "application/octet-stream", size: full.byteLength, mtime: MTIME }
        : undefined,
  };
}

function honoringLoader(): StaticLoader {
  const full = new TextEncoder().encode("0123456789");
  return {
    load: async (p: string, range?: { start: number; end: number }) => {
      if (p !== "data.bin") return undefined;
      if (!range) return { body: full, size: full.byteLength };
      return { body: full.slice(range.start, range.end + 1), size: full.byteLength };
    },
  };
}

function boundaryOf(res: Response): string {
  const ct = res.headers.get("content-type") ?? "";
  const m = /boundary=([^\s;]+)/.exec(ct);
  if (!m?.[1]) throw new Error(`no boundary in ${ct}`);
  return m[1] as string;
}

interface MpPart {
  contentType: string;
  contentRange: string;
  data: string;
}

function parseMultipart(text: string, boundary: string): MpPart[] {
  const closing = `--${boundary}--`;
  const cut = text.includes(closing) ? text.slice(0, text.indexOf(closing)) : text;
  const rawParts = cut.split(`--${boundary}`).filter((s) => s.trim().length > 0);
  return rawParts.map((raw) => {
    const sep = "\r\n\r\n";
    const idx = raw.indexOf(sep);
    if (idx === -1) throw new Error(`bad part: ${JSON.stringify(raw)}`);
    const head = raw.slice(0, idx);
    let data = raw.slice(idx + sep.length);
    if (data.endsWith("\r\n")) data = data.slice(0, -2);
    const ct = /content-type:\s*(.+)/i.exec(head)?.[1]?.trim() ?? "";
    const cr = /content-range:\s*(.+)/i.exec(head)?.[1]?.trim() ?? "";
    return { contentType: ct, contentRange: cr, data };
  });
}

// ─────────────────────────────────────────────────────────────────
// parseRangeList units
// ─────────────────────────────────────────────────────────────────

describe("track-g: parseRangeList", () => {
  it("parses multiple closed ranges", () => {
    expect(parseRangeList("bytes=0-1, 5-6", 10)).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ]);
  });

  it("parses open + suffix sets with clamping; N=0 is invalid", () => {
    expect(parseRangeList("bytes=8-, -3", 10)).toEqual([
      { start: 8, end: 9 },
      { start: 7, end: 9 },
    ]);
    expect(parseRangeList("bytes=-500", 10)).toEqual([{ start: 0, end: 9 }]);
    expect(parseRangeList("bytes=-0", 10)).toBe("invalid");
  });

  it("maps garbage in any set to invalid", () => {
    expect(parseRangeList("bananas", 10)).toBe("invalid");
    expect(parseRangeList("bytes=0-1, garbage", 10)).toBe("invalid");
    expect(parseRangeList("bytes=5-3, 0-1", 10)).toBe("invalid");
    expect(parseRangeList("bytes=", 10)).toBe("invalid");
  });

  it("maps any start>=size to unsatisfiable for the whole header", () => {
    expect(parseRangeList("bytes=0-1, 50-60", 10)).toBe("unsatisfiable");
    expect(parseRangeList("bytes=50-", 10)).toBe("unsatisfiable");
  });

  it("returns invalid when size is unknown", () => {
    expect(parseRangeList("bytes=0-1", undefined)).toBe("invalid");
    expect(parseRangeList("bytes=0-1, 2-3", undefined)).toBe("invalid");
  });

  it("returns too-many over maxRanges (default 8, custom honored)", () => {
    const nine = "bytes=0-0,1-1,2-2,3-3,4-4,5-5,6-6,7-7,8-8";
    expect(parseRangeList(nine, 10)).toBe("too-many");
    expect(parseRangeList("bytes=0-0,1-1,2-2", 10, 2)).toBe("too-many");
    expect(parseRangeList("bytes=0-0,1-1", 10, 2)).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────
// multipart/byteranges
// ─────────────────────────────────────────────────────────────────

describe("track-g: static multipart", () => {
  it("answers 206 multipart with per-part Content-Range + bytes", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1, 4-5" },
    });
    expect(res.status).toBe(206);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("multipart/byteranges");
    const boundary = boundaryOf(res);
    expect(boundary.length).toBeGreaterThan(8);
    const parts = parseMultipart(await res.text(), boundary);
    expect(parts.length).toBe(2);
    expect(parts[0]?.contentRange).toBe("bytes 0-1/10");
    expect(parts[0]?.data).toBe("01");
    expect(parts[1]?.contentRange).toBe("bytes 4-5/10");
    expect(parts[1]?.data).toBe("45");
    for (const p of parts) expect(p.contentType).toContain("octet-stream");
  });

  it("handles suffix + open mixes in multipart", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: honoringLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=-2, 0-0" },
    });
    expect(res.status).toBe(206);
    const parts = parseMultipart(await res.text(), boundaryOf(res));
    expect(parts.length).toBe(2);
    expect(parts[0]?.contentRange).toBe("bytes 8-9/10");
    expect(parts[0]?.data).toBe("89");
    expect(parts[1]?.contentRange).toBe("bytes 0-0/10");
    expect(parts[1]?.data).toBe("0");
  });

  it("preserves ETag / Cache-Control / Accept-Ranges on multipart 206", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const full = await fetchVia(app, "/static/data.bin");
    const multi = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1, 2-3" },
    });
    expect(multi.status).toBe(206);
    expect(multi.headers.get("etag")).toBe(full.headers.get("etag"));
    expect(multi.headers.get("cache-control")).toBe(full.headers.get("cache-control"));
    expect(multi.headers.get("accept-ranges")).toBe("bytes");
  });

  it("serves 200 full when ranges exceed the limit (too-many)", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-0,1-1,2-2,3-3,4-4,5-5,6-6,7-7,8-8" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("keeps single-range exact (Content-Range + bytes)", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", { headers: { range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("2345");
  });

  it("keeps 416 for unsatisfiable multi-range headers", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1, 50-60" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  });
});

// ─────────────────────────────────────────────────────────────────
// If-Range
// ─────────────────────────────────────────────────────────────────

describe("track-g: static If-Range", () => {
  it("ETag match proceeds to 206", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const full = await fetchVia(app, "/static/data.bin");
    const tag = full.headers.get("etag") ?? "";
    expect(tag.length).toBeGreaterThan(0);
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1", "if-range": tag },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("01");
  });

  it("ETag mismatch falls back to 200 full", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1", "if-range": '"0-deadbeef"' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("'*' never matches If-Range (→200)", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1", "if-range": "*" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("HTTP-date <= mtime proceeds to 206", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: mtimeLoader() }));
    const same = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1", "if-range": MTIME.toUTCString() },
    });
    expect(same.status).toBe(206);
    expect(await same.text()).toBe("01");
    const older = await fetchVia(app, "/static/data.bin", {
      headers: {
        range: "bytes=0-1",
        "if-range": new Date("2023-12-31T00:00:00Z").toUTCString(),
      },
    });
    expect(older.status).toBe(206);
  });

  it("HTTP-date > mtime falls back to 200 full", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: mtimeLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: {
        range: "bytes=0-1",
        "if-range": new Date("2024-02-01T00:00:00Z").toUTCString(),
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("If-Range without Range is ignored (200)", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: mtimeLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { "if-range": MTIME.toUTCString() },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("stale If-Range suppresses multipart (200 full, no multipart)", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1, 2-3", "if-range": '"0-deadbeef"' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).not.toContain("multipart");
    expect(await res.text()).toBe("0123456789");
  });

  it("If-None-Match is evaluated FIRST: 304 wins over Range", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const full = await fetchVia(app, "/static/data.bin");
    const tag = full.headers.get("etag") ?? "";
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1", "if-none-match": tag, "if-range": tag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });
});
