import { describe, it, expect, afterEach } from "vitest";
import { createBunLoader } from "../src/index.js";

const BYTES = new TextEncoder().encode("0123456789abcdef");
const LAST_MODIFIED = Date.parse("2024-01-01T00:00:00Z");

type MockBunFile = {
  exists(): Promise<boolean>;
  stream(): ReadableStream<Uint8Array>;
  slice(start: number, end: number): MockBunFile;
  lastModified: number;
  size: number;
};

function fileFor(data: Uint8Array, exists: boolean): MockBunFile {
  const self: MockBunFile = {
    exists: async () => exists,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(data);
          c.close();
        },
      }),
    slice: (s: number, e: number) => fileFor(data.slice(s, e), exists),
    lastModified: LAST_MODIFIED,
    size: data.byteLength,
  };
  return self;
}

async function streamToBytes(body: unknown): Promise<Uint8Array> {
  const res = new Response(body as BodyInit);
  return new Uint8Array(await res.arrayBuffer());
}

describe("runtime-bun createBunLoader (streaming, mocked Bun)", () => {
  const prevBun = (globalThis as unknown as { Bun?: unknown }).Bun;
  afterEach(() => {
    (globalThis as unknown as { Bun?: unknown }).Bun = prevBun;
  });

  function installMock(opts: { exists?: boolean; seen?: string[] } = {}): void {
    const { exists = true, seen = [] } = opts;
    (globalThis as unknown as { Bun?: unknown }).Bun = {
      file: (p: string) => {
        seen.push(p);
        return fileFor(BYTES, exists);
      },
    } as unknown;
  }

  it("streams the full body with full size + mtime", async () => {
    installMock();
    const entry = await createBunLoader("/base").load("hello.txt");
    expect(entry?.size).toBe(BYTES.byteLength);
    expect(entry?.mtime).toEqual(new Date(LAST_MODIFIED));
    expect(entry?.body).toBeInstanceOf(ReadableStream);
    await expect(streamToBytes(entry?.body)).resolves.toEqual(BYTES);
  });

  it("streams exactly bytes [start..end] on range, keeping the full size", async () => {
    installMock();
    const entry = await createBunLoader("/base").load("hello.txt", { start: 2, end: 5 });
    expect(entry?.size).toBe(BYTES.byteLength);
    await expect(streamToBytes(entry?.body)).resolves.toEqual(BYTES.slice(2, 6));
  });

  it("returns undefined for missing files and traversal (no file access)", async () => {
    installMock({ exists: false });
    await expect(createBunLoader("/base").load("missing.txt")).resolves.toBeUndefined();

    const seen: string[] = [];
    installMock({ seen });
    await expect(createBunLoader("/base").load("../outside.txt")).resolves.toBeUndefined();
    await expect(createBunLoader("/base").load("a\\b.txt")).resolves.toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("returns undefined when Bun is unavailable", async () => {
    (globalThis as unknown as { Bun?: unknown }).Bun = undefined;
    await expect(createBunLoader("/base").load("hello.txt")).resolves.toBeUndefined();
  });
});
