/**
 * alpha-track-f: streaming `multipart/form-data` parser (`mino/multipart`).
 *
 * Network-free: multipart bodies are built BY HAND (byte-exact, including
 * preamble/epilogue/quoted-boundary/`filename*`/nameless parts/empty
 * files/binary bytes) and fed via `new Request(...)`. Covers reassembly,
 * chunk-split fuzzing, all five limit breaches, bad input (400s), and a Mino
 * route integration. The parser itself never buffers whole files: bodies fed
 * in small chunks are yielded in multiple pieces.
 */
import { describe, it, expect } from "vitest";
import { Mino } from "../src/mino.js";
import { parseMultipart, partText, collectPart } from "../src/multipart.js";
import type { MultipartPart } from "../src/multipart.js";
import { BadRequestError, PayloadTooLargeError } from "../src/errors.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

interface SpecPart {
  headers: string[];
  body: Uint8Array | string;
}

/**
 * Build a byte-exact multipart body by hand: optional preamble, one
 * `--boundary` section per part, `--boundary--` close, optional epilogue.
 */
function buildBody(
  boundary: string,
  parts: SpecPart[],
  opts: { preamble?: Uint8Array | string; epilogue?: Uint8Array | string } = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  if (opts.preamble !== undefined) {
    chunks.push(typeof opts.preamble === "string" ? enc(opts.preamble) : opts.preamble);
  }
  for (const part of parts) {
    chunks.push(enc(`--${boundary}\r\n`));
    for (const h of part.headers) chunks.push(enc(`${h}\r\n`));
    chunks.push(enc("\r\n"));
    chunks.push(typeof part.body === "string" ? enc(part.body) : part.body);
    chunks.push(enc("\r\n"));
  }
  chunks.push(enc(`--${boundary}--`));
  if (opts.epilogue !== undefined) {
    chunks.push(typeof opts.epilogue === "string" ? enc(opts.epilogue) : opts.epilogue);
  }
  return concat(...chunks);
}

function plainRequest(body: Uint8Array, boundary: string): Request {
  return new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: body as unknown as BodyInit,
  });
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Feed `body` in fixed-size chunks through a streaming request body. */
function chunkedRequest(
  body: Uint8Array,
  boundary: string,
  chunkSize: number,
  contentType?: string,
): Request {
  const chunks: Uint8Array[] = [];
  const size = Math.max(1, chunkSize);
  for (let off = 0; off < body.length; off += size) {
    chunks.push(body.slice(off, off + size));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  return new Request("http://localhost/upload", {
    method: "POST",
    headers: {
      "content-type": contentType ?? `multipart/form-data; boundary=${boundary}`,
    },
    body: streamOf(chunks) as unknown as BodyInit,
    duplex: "half",
  } as unknown as RequestInit);
}

/** Feed `body` split at one exact offset (two chunks). */
function splitRequest(body: Uint8Array, boundary: string, at: number): Request {
  return new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: streamOf([body.slice(0, at), body.slice(at)]) as unknown as BodyInit,
    duplex: "half",
  } as unknown as RequestInit);
}

async function collectBody(part: MultipartPart, cap = 10_000_000): Promise<Uint8Array> {
  return collectPart(part, cap);
}

const textOf = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array(0));

/** Unwrap-or-throw (avoids unsafe-optional-chaining lints in assertions). */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

/** partText on a fresh request (bodies are single-use — never pre-drain). */
async function firstPartText(req: Request): Promise<string> {
  for await (const part of parseMultipart(req)) return partText(part);
  throw new Error("expected at least one part");
}

async function drainAll(
  req: Request,
  opts?: Parameters<typeof parseMultipart>[1],
): Promise<Array<{ part: MultipartPart; bytes: Uint8Array }>> {
  const out: Array<{ part: MultipartPart; bytes: Uint8Array }> = [];
  for await (const part of parseMultipart(req, opts)) {
    out.push({ part, bytes: await collectBody(part) });
  }
  return out;
}

const FIELD = (name: string, value: string, extraHeaders: string[] = []): SpecPart => ({
  headers: [`Content-Disposition: form-data; name="${name}"`, ...extraHeaders],
  body: value,
});

const FILE = (
  name: string,
  filename: string,
  body: Uint8Array | string,
  contentType = "application/octet-stream",
): SpecPart => ({
  headers: [
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
  ],
  body,
});

describe("track F: basic parsing", () => {
  it("parses a single text field (name/value via partText)", async () => {
    const all = await drainAll(plainRequest(buildBody("b1", [FIELD("hello", "world")]), "b1"));
    expect(all.length).toBe(1);
    expect(all[0]?.part.name).toBe("hello");
    expect(all[0]?.part.filename).toBeUndefined();
    expect(textOf(all[0]?.bytes)).toBe("world");
    expect(
      await firstPartText(plainRequest(buildBody("b1", [FIELD("hello", "world")]), "b1")),
    ).toBe("world");
  });

  it("parses a file part (filename, essence content-type, headers, exact bytes)", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 13, 10, 65]);
    const all = await drainAll(
      plainRequest(
        buildBody("b2", [FILE("doc", "a.bin", bytes, "application/octet-stream")]),
        "b2",
      ),
    );
    expect(all.length).toBe(1);
    const part = all[0]?.part as MultipartPart;
    expect(part.name).toBe("doc");
    expect(part.filename).toBe("a.bin");
    expect(part.contentType).toBe("application/octet-stream");
    expect(part.headers).toBeInstanceOf(Headers);
    expect(part.headers.get("content-disposition")).toContain('filename="a.bin"');
    expect(all[0]?.bytes).toEqual(bytes);
  });

  it("keeps only the content-type essence in part.contentType", async () => {
    const all = await drainAll(
      plainRequest(
        buildBody("b3", [FIELD("t", "x", ["Content-Type: text/plain; charset=utf-8"])]),
        "b3",
      ),
    );
    expect(must(all[0]).part.contentType).toBe("text/plain");
  });

  it("ignores preamble and epilogue", async () => {
    const all = await drainAll(
      plainRequest(
        buildBody("b4", [FIELD("a", "1")], {
          preamble: "junk preamble\r\n--not-the-boundary\r\n",
          epilogue: "\r\ntrailing junk --b4?",
        }),
        "b4",
      ),
    );
    expect(all.length).toBe(1);
    expect(textOf(all[0]?.bytes)).toBe("1");
  });

  it("accepts a quoted boundary in content-type", async () => {
    const body = buildBody("quoted-123", [FIELD("a", "b")]);
    const req = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": 'multipart/form-data; boundary="quoted-123"' },
      body: body as unknown as BodyInit,
    });
    const all = await drainAll(req);
    expect(all.length).toBe(1);
    expect(textOf(all[0]?.bytes)).toBe("b");
  });

  it("lets explicit boundary opt override the header", async () => {
    const body = buildBody("real", [FIELD("a", "b")]);
    const req = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=wrong" },
      body: body as unknown as BodyInit,
    });
    const all = await drainAll(req, { boundary: "real" });
    expect(all.length).toBe(1);
    expect(textOf(all[0]?.bytes)).toBe("b");
  });

  it("rejects an invalid explicit boundary synchronously", () => {
    const req = plainRequest(buildBody("x", []), "x");
    expect(() => parseMultipart(req, { boundary: "  " })).toThrow(BadRequestError);
    expect(() => parseMultipart(req, { boundary: "" })).toThrow(BadRequestError);
  });

  it("yields zero parts for an empty body", async () => {
    const req = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
    });
    expect(req.body).toBeNull();
    const all = await drainAll(req);
    expect(all).toEqual([]);
  });
});

describe("track F: dispositions", () => {
  it("decodes filename* (RFC 5987 UTF-8) and prefers it over filename", async () => {
    const body = buildBody("b5", [
      {
        headers: [
          `Content-Disposition: form-data; name="f"; filename="fallback.txt"; filename*=UTF-8''%E2%82%ACrates.txt`,
          "Content-Type: text/plain",
        ],
        body: "data",
      },
    ]);
    const all = await drainAll(plainRequest(body, "b5"));
    expect(must(all[0]).part.filename).toBe("€rates.txt");
  });

  it("falls back to filename when filename* is malformed", async () => {
    const body = buildBody("b6", [
      {
        headers: [
          `Content-Disposition: form-data; name="f"; filename="ok.txt"; filename*=bogus`,
          "Content-Type: text/plain",
        ],
        body: "data",
      },
    ]);
    const all = await drainAll(plainRequest(body, "b6"));
    expect(must(all[0]).part.filename).toBe("ok.txt");
  });

  it('treats filename="" as a (empty-named) file part', async () => {
    const all = await drainAll(plainRequest(buildBody("b7", [FILE("f", "", "x")]), "b7"));
    expect(must(all[0]).part.filename).toBe("");
  });

  it("decodes raw UTF-8 filenames (what browsers send)", async () => {
    const body = buildBody("u1", [FILE("f", "café-€.txt", "d")]);
    const all = await drainAll(plainRequest(body, "u1"));
    expect(all.length).toBe(1);
    expect(must(all[0]).part.filename).toBe("café-€.txt");
  });

  it("handles quoted ; = and escaped quotes in filenames", async () => {
    const body = buildBody("u2", [
      {
        headers: ['Content-Disposition: form-data; name="f"; filename="a=b;c\\"d.txt"'],
        body: "d",
      },
    ]);
    const all = await drainAll(plainRequest(body, "u2"));
    expect(all.length).toBe(1);
    expect(must(all[0]).part.filename).toBe('a=b;c"d.txt');
  });

  it("skips parts without a name and parts without content-disposition", async () => {
    const body = buildBody("b8", [
      {
        headers: ['Content-Disposition: form-data; filename="orphan.bin"'],
        body: "orphan-bytes",
      },
      { headers: ["Content-Type: text/plain"], body: "no-disposition" },
      FIELD("kept", "yes"),
    ]);
    const all = await drainAll(plainRequest(body, "b8"));
    expect(all.length).toBe(1);
    expect(must(all[0]).part.name).toBe("kept");
  });

  it("parses multiple files with exact bytes", async () => {
    const bodies = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6, 7, 8]),
      new Uint8Array([9]),
    ];
    const all = await drainAll(
      plainRequest(
        buildBody(
          "b9",
          bodies.map((b, i) => FILE(`f${i}`, `f${i}.bin`, b)),
        ),
        "b9",
      ),
    );
    expect(all.length).toBe(3);
    expect(all.map((r) => r.bytes)).toEqual(bodies);
    expect(all.map((r) => r.part.filename)).toEqual(["f0.bin", "f1.bin", "f2.bin"]);
  });

  it("supports empty files and empty fields", async () => {
    const all = await drainAll(
      plainRequest(
        buildBody("b10", [FILE("e", "empty.bin", new Uint8Array(0)), FIELD("ef", "")]),
        "b10",
      ),
    );
    expect(all.length).toBe(2);
    expect(all[0]?.bytes.byteLength).toBe(0);
    expect(textOf(all[1]?.bytes)).toBe("");
  });

  it("keeps binary content with boundary-like prefixes as data", async () => {
    const boundary = "BOUND";
    // `\r\n--BOUNDX` (invalid suffix), `\r\n--BOUN` (no match), NUL/0xFF bytes.
    const tricky = concat(
      enc("start\r\n--BOUNDX-middle\r\n--BOUN\r\n"),
      new Uint8Array([0, 255, 13, 10, 0]),
      enc("end"),
    );
    const all = await drainAll(
      plainRequest(buildBody(boundary, [FILE("bin", "t.bin", tricky)]), boundary),
    );
    expect(all.length).toBe(1);
    expect(all[0]?.bytes).toEqual(tricky);
  });

  it("ignores transfer-encoding and malformed header lines, tolerates bad header values", async () => {
    const body = concat(
      enc("--b11\r\n"),
      enc('Content-Disposition: form-data; name="f"\r\n'),
      enc("Content-Transfer-Encoding: binary\r\n"),
      enc("This line has no colon\r\n"),
      enc("X-Junk: a\0b\r\n"),
      enc("Content-Type: text/plain\r\n"),
      enc("\r\n"),
      enc("payload\r\n"),
      enc("--b11--"),
    );
    const all = await drainAll(plainRequest(body, "b11"));
    expect(all.length).toBe(1);
    expect(textOf(all[0]?.bytes)).toBe("payload");
  });
});

describe("track F: streaming + chunk splits", () => {
  it("yields file bytes in multiple chunks when fed in small chunks", async () => {
    const boundary = "stream1";
    const data = new Uint8Array(5000).map((_, i) => i % 251);
    const body = buildBody(boundary, [FILE("big", "big.bin", data)]);
    const seen: Uint8Array[] = [];
    for await (const part of parseMultipart(chunkedRequest(body, boundary, 128))) {
      for await (const chunk of part.body) seen.push(chunk);
    }
    expect(seen.length).toBeGreaterThan(1);
    expect(concat(...seen)).toEqual(data);
  });

  it("reassembles exactly at EVERY single-byte split of a small body", async () => {
    const boundary = "fuzz";
    const body = buildBody(boundary, [
      FIELD("name", "value-123"),
      FILE("f", "a.bin", new Uint8Array([10, 13, 10, 45, 45, 102, 117, 122, 122, 200])),
    ]);
    const expected = await drainAll(plainRequest(body, boundary));
    for (let at = 0; at <= body.byteLength; at++) {
      const all = await drainAll(splitRequest(body, boundary, at));
      expect(all.length).toBe(expected.length);
      for (let i = 0; i < all.length; i++) {
        expect(all[i]?.part.name).toBe(expected[i]?.part.name);
        expect(all[i]?.part.filename).toBe(expected[i]?.part.filename);
        expect(all[i]?.bytes).toEqual(expected[i]?.bytes);
      }
    }
  });

  it("reassembles a larger binary body split at many points incl. delimiter edges", async () => {
    const boundary = "edge-delim-99";
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 256;
    };
    const data = new Uint8Array(6000).map(() => rand());
    const body = buildBody(boundary, [
      FIELD("a", "hello"),
      FILE("blob", "r.bin", data),
      FIELD("z", "bye"),
    ]);
    const points = new Set<number>([1, 2, 3, 7, 8, 15, 16, 31, 32, 33, 63, 64, 65]);
    for (let off = 0; off < body.byteLength; off += 97) points.add(off);
    points.add(body.byteLength - 1);
    for (const at of points) {
      const all = await drainAll(splitRequest(body, boundary, at));
      expect(all.length).toBe(3);
      expect(all[1]?.bytes).toEqual(data);
      expect(textOf(all[0]?.bytes)).toBe("hello");
      expect(textOf(all[2]?.bytes)).toBe("bye");
    }
  });

  it("auto-discards an unconsumed body when advancing to the next part", async () => {
    const boundary = "drain1";
    const first = new Uint8Array(3000).map((_, i) => i % 256);
    const second = new Uint8Array([9, 8, 7]);
    const body = buildBody(boundary, [FILE("one", "1.bin", first), FILE("two", "2.bin", second)]);
    const req = chunkedRequest(body, boundary, 64);
    const names: string[] = [];
    const sizes: number[] = [];
    for await (const part of parseMultipart(req)) {
      names.push(part.name);
      if (part.name === "one") {
        // Consume only the first chunk, abandon the rest.
        const reader = part.body[Symbol.asyncIterator]();
        const r = await reader.next();
        expect(r.done).toBe(false);
        sizes.push((r.value as Uint8Array).byteLength);
        await reader.return?.(undefined);
        void r;
      } else {
        sizes.push((await collectPart(part, 1_000_000)).byteLength);
      }
    }
    expect(names).toEqual(["one", "two"]);
    expect(sizes[0]).toBeGreaterThan(0);
    expect(sizes[0]).toBeLessThan(first.byteLength);
    expect(sizes[1]).toBe(second.byteLength);
  });
});

describe("track F: limits (all five → 413 mid-stream)", () => {
  const big = (n: number): Uint8Array => new Uint8Array(n).map((_, i) => i % 256);

  it("maxFileSize: partial bytes stream, then PayloadTooLargeError", async () => {
    const boundary = "lim1";
    const data = big(1000);
    const body = buildBody(boundary, [FILE("f", "a.bin", data)]);
    let partial = 0;
    await expect(
      (async () => {
        for await (const part of parseMultipart(chunkedRequest(body, boundary, 100), {
          maxFileSize: 250,
        })) {
          for await (const chunk of part.body) partial += chunk.byteLength;
        }
      })(),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(data.byteLength);
    try {
      for await (const part of parseMultipart(chunkedRequest(body, boundary, 100), {
        maxFileSize: 250,
      })) {
        for await (const _c of part.body) {
          // drain
        }
      }
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(413);
    }
  });

  it("maxFiles: 11th file → 413", async () => {
    const boundary = "lim2";
    const parts = Array.from({ length: 11 }, (_, i) => FILE(`f${i}`, `${i}.bin`, "x"));
    await expect(
      drainAll(plainRequest(buildBody(boundary, parts), boundary), { maxFiles: 10 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("maxFields: 3rd named part → 413", async () => {
    const boundary = "lim3";
    const parts = [FIELD("a", "1"), FIELD("b", "2"), FIELD("c", "3")];
    await expect(
      drainAll(plainRequest(buildBody(boundary, parts), boundary), { maxFields: 2 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("maxFieldSize: oversize field → 413", async () => {
    const boundary = "lim4";
    const body = buildBody(boundary, [FIELD("big", "y".repeat(1000))]);
    await expect(
      drainAll(plainRequest(body, boundary), { maxFieldSize: 10 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("maxTotalBytes: second file pushes past the total → 413", async () => {
    const boundary = "lim5";
    const parts = [FILE("a", "a.bin", big(200)), FILE("b", "b.bin", big(200))];
    await expect(
      drainAll(plainRequest(buildBody(boundary, parts), boundary), { maxTotalBytes: 300 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("partText/collectPart enforce their own caps", async () => {
    const boundary = "lim6";
    const body = buildBody(boundary, [FIELD("v", "0123456789")]);
    for await (const part of parseMultipart(plainRequest(body, boundary))) {
      await expect(partText(part, 5)).rejects.toBeInstanceOf(PayloadTooLargeError);
    }
    for await (const part of parseMultipart(plainRequest(body, boundary))) {
      await expect(collectPart(part, 5)).rejects.toBeInstanceOf(PayloadTooLargeError);
    }
  });
});

describe("track F: bad input (400s)", () => {
  it("missing content-type → BadRequestError (sync throw)", () => {
    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: enc("x") as unknown as BodyInit,
    });
    expect(() => parseMultipart(req)).toThrow(BadRequestError);
    try {
      parseMultipart(req);
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
    }
  });

  it("non-multipart content-type → BadRequestError", () => {
    const req = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: enc("{}") as unknown as BodyInit,
    });
    expect(() => parseMultipart(req)).toThrow(BadRequestError);
  });

  it("multipart without boundary → BadRequestError", () => {
    const req = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: enc("--x--") as unknown as BodyInit,
    });
    expect(() => parseMultipart(req)).toThrow(BadRequestError);
  });

  it("part headers past 8kb → 400", async () => {
    const boundary = "lim7";
    const body = buildBody(boundary, [
      {
        headers: [`Content-Disposition: form-data; name="a"`, `X-Pad: ${"p".repeat(9000)}`],
        body: "x",
      },
    ]);
    await expect(drainAll(plainRequest(body, boundary))).rejects.toMatchObject({ status: 400 });
  });

  it("truncated body (no close delimiter) → BadRequestError", async () => {
    const body = concat(
      enc("--t9\r\n"),
      enc('Content-Disposition: form-data; name="a"\r\n'),
      enc("\r\n"),
      enc("hello"),
    );
    await expect(drainAll(plainRequest(body, "t9"))).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("track F: boundary validation", () => {
  it("rejects overlong and control-char boundaries", () => {
    const req = plainRequest(buildBody("x", []), "x");
    expect(() => parseMultipart(req, { boundary: "y".repeat(71) })).toThrow(BadRequestError);
    expect(() => parseMultipart(req, { boundary: "a\tb" })).toThrow(BadRequestError);
  });

  it("rejects a quoted-empty boundary in content-type", () => {
    const req = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": 'multipart/form-data; boundary=""' },
      body: enc("--x--") as unknown as BodyInit,
    });
    expect(() => parseMultipart(req)).toThrow(BadRequestError);
  });
});

describe("track F: delimiter edges", () => {
  it("close delimiter as the whole body yields zero parts", async () => {
    expect(await drainAll(plainRequest(enc("--solo--"), "solo"))).toEqual([]);
  });

  it("ignores boundary-like text in the preamble (invalid suffix)", async () => {
    const all = await drainAll(
      plainRequest(
        buildBody("pp", [FIELD("a", "1")], { preamble: "noise --ppZ more --pp- end" }),
        "pp",
      ),
    );
    expect(all.length).toBe(1);
    expect(textOf(all[0]?.bytes)).toBe("1");
  });

  it("accepts transport padding (spaces/tabs) before delimiter CRLF, one byte at a time", async () => {
    const body = concat(
      enc("--pad\r\n"),
      enc('Content-Disposition: form-data; name="a"\r\n\r\n'),
      enc("v\r\n--pad   \t \r\n"),
      enc('Content-Disposition: form-data; name="b"\r\n\r\n'),
      enc("w\r\n--pad--"),
    );
    const all = await drainAll(chunkedRequest(body, "pad", 1));
    expect(all.map((r) => r.part.name)).toEqual(["a", "b"]);
    expect(textOf(all[0]?.bytes)).toBe("v");
    expect(textOf(all[1]?.bytes)).toBe("w");
  });

  it("accepts a lone-LF delimiter terminator", async () => {
    const body = concat(
      enc("--suf\n"),
      enc('Content-Disposition: form-data; name="a"\r\n\r\n'),
      enc("v\r\n--suf--"),
    );
    const all = await drainAll(plainRequest(body, "suf"));
    expect(all.length).toBe(1);
    expect(textOf(all[0]?.bytes)).toBe("v");
  });

  it("parses a multi-part body fed one byte at a time", async () => {
    const boundary = "bytewise";
    const data = new Uint8Array([1, 2, 3, 13, 10, 45, 45]);
    const body = buildBody(boundary, [FIELD("a", "x"), FILE("f", "d.bin", data)]);
    const all = await drainAll(chunkedRequest(body, boundary, 1));
    expect(all.length).toBe(2);
    expect(textOf(all[0]?.bytes)).toBe("x");
    expect(all[1]?.bytes).toEqual(data);
  });

  it("truncated mid-header body → BadRequestError", async () => {
    const body = concat(enc("--t8\r\n"), enc('Content-Disposition: form-data; name="a'));
    await expect(drainAll(plainRequest(body, "t8"))).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("track F: filename* edges", () => {
  const starBody = (boundary: string, star: string): Uint8Array =>
    buildBody(boundary, [
      {
        headers: [
          `Content-Disposition: form-data; name="f"; filename="fb.txt"; filename*=${star}`,
          "Content-Type: text/plain",
        ],
        body: "d",
      },
    ]);

  it("keeps a literal % when not a valid escape", async () => {
    const all = await drainAll(plainRequest(starBody("s1", "UTF-8''100%sure.txt"), "s1"));
    expect(must(all[0]).part.filename).toBe("100%sure.txt");
  });

  it("falls back to UTF-8 on unknown charset", async () => {
    const all = await drainAll(plainRequest(starBody("s2", "X-BOGUS''hi.txt"), "s2"));
    expect(must(all[0]).part.filename).toBe("hi.txt");
  });

  it("re-encodes raw non-ASCII literals as UTF-8", async () => {
    const all = await drainAll(plainRequest(starBody("s3", "UTF-8''€.txt"), "s3"));
    expect(must(all[0]).part.filename).toBe("€.txt");
  });

  it("ignores bare tokens in content-disposition", async () => {
    const body = buildBody("s4", [
      { headers: ['Content-Disposition: form-data; bare-token; name="k"'], body: "v" },
    ]);
    const all = await drainAll(plainRequest(body, "s4"));
    expect(all.length).toBe(1);
    expect(textOf(all[0]?.bytes)).toBe("v");
  });
});

describe("track F: Mino route integration", () => {
  function uploadApp(opts?: Parameters<typeof parseMultipart>[1]): Mino {
    const app = new Mino();
    app.post("/upload", async (c) => {
      const fields: Record<string, string> = {};
      const files: Array<{ field: string; filename: string; size: number }> = [];
      for await (const part of parseMultipart(c.req, opts)) {
        if (part.filename !== undefined) {
          let size = 0;
          for await (const chunk of part.body) size += chunk.byteLength;
          files.push({ field: part.name, filename: part.filename, size });
        } else {
          fields[part.name] = await partText(part);
        }
      }
      return c.json({ fields, files });
    });
    return app;
  }

  it("upload handler returns parsed fields + files", async () => {
    const boundary = "route1";
    const data = new Uint8Array([7, 7, 7, 7]);
    const body = buildBody(boundary, [
      FIELD("title", "hi"),
      FILE("avatar", "me.png", data, "image/png"),
    ]);
    const res = await uploadApp().fetch(plainRequest(body, boundary));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fields: { title: "hi" },
      files: [{ field: "avatar", filename: "me.png", size: 4 }],
    });
  });

  it("limit breach through a route → 413 {error,status,code} JSON", async () => {
    const boundary = "route2";
    const body = buildBody(boundary, [FILE("f", "a.bin", new Uint8Array(100))]);
    const res = await uploadApp({ maxFileSize: 10 }).fetch(plainRequest(body, boundary));
    expect(res.status).toBe(413);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["status"]).toBe(413);
    expect(typeof json["error"]).toBe("string");
    expect(json["code"]).toBe("payload_too_large");
  });
});
