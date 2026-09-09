/**
 * alpha-track-d: file downloads (`Context.file`), HTTP Range in serveStatic,
 * and `validator("octet-stream")`.
 *
 * Hermetic — all in-process via `app.fetch`. No external network, no
 * filesystem, no secrets in logs.
 */
import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { DEFAULT_LIMITS } from "../src/context.js";
import { validator } from "../src/validator.js";
import { serveStatic, type StaticLoader } from "../src/static.js";
import {
  contentDisposition,
  contentTypeForExt,
  formatContentRange,
  parseRange,
} from "../src/file.js";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function fetchVia(app: Mino, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(req(path, init));
}

// ─────────────────────────────────────────────────────────────────
// file.ts: contentDisposition
// ─────────────────────────────────────────────────────────────────

describe("track-d: contentDisposition", () => {
  it("defaults to attachment with quoted fallback + RFC 5987 filename*", () => {
    const v = contentDisposition("report.pdf");
    expect(v.startsWith("attachment;")).toBe(true);
    expect(v).toContain('filename="report.pdf"');
    expect(v).toContain("filename*=UTF-8''report.pdf");
  });

  it("encodes unicode in filename* with an ASCII fallback", () => {
    const v = contentDisposition("résumé.pdf");
    expect(v).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(v).toContain('filename="r_sum_.pdf"');
    expect(v.startsWith("attachment;")).toBe(true);
  });

  it("supports inline disposition", () => {
    const v = contentDisposition("a.pdf", "inline");
    expect(v.startsWith("inline;")).toBe(true);
    expect(v).toContain('filename="a.pdf"');
  });

  it("strips CRLF and quotes (header-injection safe)", () => {
    const v = contentDisposition('a\r\nb"c.pdf');
    expect(v).not.toContain("\r");
    expect(v).not.toContain("\n");
    expect(v).toContain('filename="abc.pdf"');
  });

  it("rejects empty names with a plain Error", () => {
    expect(() => contentDisposition("")).toThrowError(Error);
    expect(() => contentDisposition('"\r\n"')).toThrowError(Error);
    expect(() => contentDisposition("   ")).toThrowError(Error);
  });
});

// ─────────────────────────────────────────────────────────────────
// file.ts: contentTypeForExt + formatContentRange
// ─────────────────────────────────────────────────────────────────

describe("track-d: contentTypeForExt + formatContentRange", () => {
  it("infers known extensions and falls back to octet-stream", () => {
    expect(contentTypeForExt("app.js")).toContain("javascript");
    expect(contentTypeForExt("doc.PDF")).toBe("application/pdf");
    expect(contentTypeForExt("noext")).toBe("application/octet-stream");
    expect(contentTypeForExt("weird.blah")).toBe("application/octet-stream");
  });

  it('formats Content-Range as "bytes s-e/size"', () => {
    expect(formatContentRange(0, 99, 200)).toBe("bytes 0-99/200");
    expect(formatContentRange(50, 59, 100)).toBe("bytes 50-59/100");
  });
});

// ─────────────────────────────────────────────────────────────────
// file.ts: parseRange matrix
// ─────────────────────────────────────────────────────────────────

describe("track-d: parseRange", () => {
  it("parses a single closed range", () => {
    expect(parseRange("bytes=0-99", 200)).toEqual({ start: 0, end: 99 });
  });

  it("parses an open-ended range to size-1", () => {
    expect(parseRange("bytes=50-", 200)).toEqual({ start: 50, end: 199 });
  });

  it("parses a suffix range as the last N bytes", () => {
    expect(parseRange("bytes=-10", 200)).toEqual({ start: 190, end: 199 });
  });

  it("clamps suffix ranges larger than the representation", () => {
    expect(parseRange("bytes=-500", 200)).toEqual({ start: 0, end: 199 });
  });

  it("rejects zero-length suffix as invalid", () => {
    expect(parseRange("bytes=-0", 200)).toBe("invalid");
  });

  it("maps multiple ranges (comma) to multipart", () => {
    expect(parseRange("bytes=0-1, 2-3", 200)).toBe("multipart");
  });

  it("maps garbage to invalid", () => {
    expect(parseRange("bananas", 200)).toBe("invalid");
    expect(parseRange("bytes=abc", 200)).toBe("invalid");
    expect(parseRange("bytes=", 200)).toBe("invalid");
    expect(parseRange(undefined, 200)).toBe("invalid");
  });

  it("maps start>=size to unsatisfiable", () => {
    expect(parseRange("bytes=500-600", 200)).toBe("unsatisfiable");
    expect(parseRange("bytes=200-", 200)).toBe("unsatisfiable");
  });

  it("never returns unsatisfiable when size is unknown", () => {
    expect(parseRange("bytes=500-600", undefined)).toBe("invalid");
    expect(parseRange("bytes=50-", undefined)).toBe("invalid");
    expect(parseRange("bytes=-10", undefined)).toBe("invalid");
  });
});

// ─────────────────────────────────────────────────────────────────
// Context.file()
// ─────────────────────────────────────────────────────────────────

describe("track-d: Context.file", () => {
  function fileApp(
    data: BodyInit | Uint8Array | null,
    opts?: { filename?: string; disposition?: "attachment" | "inline"; type?: string },
  ): Mino {
    const app = new Mino();
    app.get("/f", (c) => c.file(data, opts));
    return app;
  }

  it("sets attachment disposition + inferred content-type", async () => {
    const app = fileApp(new TextEncoder().encode("pdf-bytes"), { filename: "report.pdf" });
    const res = await fetchVia(app, "/f");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment;");
    expect(res.headers.get("content-disposition")).toContain('filename="report.pdf"');
    expect(await res.text()).toBe("pdf-bytes");
  });

  it("supports inline disposition", async () => {
    const app = fileApp(new TextEncoder().encode("x"), {
      filename: "a.pdf",
      disposition: "inline",
    });
    const res = await fetchVia(app, "/f");
    expect(res.headers.get("content-disposition")?.startsWith("inline;")).toBe(true);
  });

  it("lets explicit type override inference", async () => {
    const app = fileApp(new TextEncoder().encode("x"), {
      filename: "a.pdf",
      type: "application/x-custom",
    });
    const res = await fetchVia(app, "/f");
    expect(res.headers.get("content-type")).toBe("application/x-custom");
  });

  it("defaults to octet-stream with no disposition when filename is absent", async () => {
    const app = fileApp(new Uint8Array([1, 2, 3]));
    const res = await fetchVia(app, "/f");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────
// serveStatic Range support
// ─────────────────────────────────────────────────────────────────

function bytesLoader(): StaticLoader {
  const enc = new TextEncoder();
  const full = enc.encode("0123456789");
  const files = new Map<string, Uint8Array>([["data.bin", full]]);
  return {
    // Range-ignoring loader: always returns the full body (server must slice).
    load: async (p: string) => {
      const body = files.get(p);
      if (!body) return undefined;
      return { body, type: "application/octet-stream", size: body.byteLength };
    },
  };
}

function honoringLoader(): StaticLoader {
  const enc = new TextEncoder();
  const full = enc.encode("0123456789");
  return {
    load: async (p: string, range?: { start: number; end: number }) => {
      if (p !== "data.bin") return undefined;
      if (!range) return { body: full, size: full.byteLength };
      return { body: full.slice(range.start, range.end + 1), size: full.byteLength };
    },
  };
}

describe("track-d: static Range", () => {
  it("answers 206 for a single range with Content-Range/Length", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", { headers: { range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("2345");
  });

  it("answers 206 for suffix and open ranges", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: honoringLoader() }));
    const suffix = await fetchVia(app, "/static/data.bin", { headers: { range: "bytes=-3" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");
    const open = await fetchVia(app, "/static/data.bin", { headers: { range: "bytes=8-" } });
    expect(open.status).toBe(206);
    expect(open.headers.get("content-range")).toBe("bytes 8-9/10");
    expect(await open.text()).toBe("89");
  });

  it("preserves ETag/Last-Modified/Cache-Control on 206", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: honoringLoader() }));
    const full = await fetchVia(app, "/static/data.bin");
    const part = await fetchVia(app, "/static/data.bin", { headers: { range: "bytes=0-1" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("etag")).toBe(full.headers.get("etag"));
    expect(part.headers.get("cache-control")).toBe(full.headers.get("cache-control"));
  });

  it("answers 416 with Content-Range bytes */size and an empty body", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", { headers: { range: "bytes=50-60" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
    expect(await res.text()).toBe("");
  });

  it("serves 206 multipart/byteranges for multi-range requests", async () => {
    // Behavior change (multipart/byteranges + If-Range track-g): 2..8 ranges
    // now yield 206 multipart instead of the legacy 200 full.
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", {
      headers: { range: "bytes=0-1, 2-3" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toContain("multipart/byteranges");
    const text = await res.text();
    expect(text).toContain("bytes 0-1/10");
    expect(text).toContain("bytes 2-3/10");
  });

  it("serves 200 full for invalid ranges", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", { headers: { range: "bytes=garbage" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("0123456789");
  });

  it("always sets Accept-Ranges on 200", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  it("slices Uint8Array locally when the loader ignores range", async () => {
    // bytesLoader() ignores the 2nd arg by design — a 206 proves the server slice.
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const res = await fetchVia(app, "/static/data.bin", { headers: { range: "bytes=0-1" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1/10");
    expect(await res.text()).toBe("01");
  });

  it("serves 200 full when size is unknown (stream without size)", async () => {
    const loader: StaticLoader = {
      load: async (p: string) =>
        p === "live.bin"
          ? {
              body: new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode("chunk"));
                  c.close();
                },
              }) as unknown as BodyInit,
              type: "application/octet-stream",
            }
          : undefined,
    };
    const app = new Mino();
    app.use(serveStatic({ loader }));
    const res = await fetchVia(app, "/static/live.bin", { headers: { range: "bytes=0-1" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("chunk");
  });

  it("keeps existing behaviors intact (404 JSON, content-type inference)", async () => {
    const app = new Mino();
    app.use(serveStatic({ loader: bytesLoader() }));
    const missing = await fetchVia(app, "/static/missing.bin");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ status: 404, code: "not_found" });
    const hit = await fetchVia(app, "/static/data.bin");
    expect(hit.headers.get("content-type")).toBe("application/octet-stream");
    expect(await hit.text()).toBe("0123456789");
  });
});

// ─────────────────────────────────────────────────────────────────
// validator("octet-stream")
// ─────────────────────────────────────────────────────────────────

const byteSchema = {
  safeParse: (v: unknown) => {
    if (v instanceof Uint8Array && v.byteLength >= 3) {
      return { success: true as const, data: v };
    }
    return { success: false as const, error: { issues: [{ message: "too short" }] } };
  },
};

describe("track-d: validator octet-stream", () => {
  it("exposes an octet default limit of 100kb", () => {
    expect(DEFAULT_LIMITS.octet).toBe(100 * 1024);
  });

  it("validates raw bytes with a 200", async () => {
    const app = new Mino();
    app.post("/bytes", validator("octet-stream", byteSchema as never), (c) =>
      c.json({ size: c.valid<Uint8Array>("octet-stream").byteLength }),
    );
    const res = await fetchVia(app, "/bytes", {
      method: "POST",
      body: new Uint8Array([1, 2, 3, 4]) as unknown as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ size: 4 });
  });

  it("returns 422 with {error,status,code} on schema failure", async () => {
    const app = new Mino();
    app.post("/bytes", validator("octet-stream", byteSchema as never), (c) => c.text("ok"));
    const res = await fetchVia(app, "/bytes", {
      method: "POST",
      body: new Uint8Array([1]) as unknown as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ status: 422, code: "validation_failed" });
  });

  it("returns 413 over the per-route limit", async () => {
    const app = new Mino();
    app.post("/bytes", validator("octet-stream", byteSchema as never, { limit: 4 }), (c) =>
      c.text("ok"),
    );
    const res = await fetchVia(app, "/bytes", {
      method: "POST",
      body: new Uint8Array(10) as unknown as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ status: 413, code: "payload_too_large" });
  });
});
