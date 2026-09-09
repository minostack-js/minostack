import { describe, it, expect, afterEach } from "vitest";
import { createDenoLoader } from "../src/index.js";

const BYTES = new TextEncoder().encode("0123456789abcdef");
const MTIME = new Date("2024-01-01T00:00:00Z");

type MockHandle = {
  read(buf: Uint8Array): Promise<number | null>;
  seek(offset: number, whence: string): Promise<number>;
  close(): void;
};

type OpenedFile = { closed: boolean; closeCalls: number };

async function streamToBytes(body: unknown): Promise<Uint8Array> {
  const res = new Response(body as BodyInit);
  return new Uint8Array(await res.arrayBuffer());
}

describe("runtime-deno createDenoLoader (streaming, mocked Deno)", () => {
  const prevDeno = (globalThis as unknown as { Deno?: unknown }).Deno;
  afterEach(() => {
    (globalThis as unknown as { Deno?: unknown }).Deno = prevDeno;
  });

  function installMock(opts: { isFile?: boolean; exists?: boolean; hang?: boolean } = {}): {
    statCalls: string[];
    opened: OpenedFile[];
  } {
    const { isFile = true, exists = true, hang = false } = opts;
    const statCalls: string[] = [];
    const opened: OpenedFile[] = [];
    const mock = {
      stat: async (p: string) => {
        statCalls.push(p);
        if (!exists) throw new Error("not found");
        return { isFile, mtime: MTIME, size: BYTES.byteLength };
      },
      open: async (p: string, _opts?: { read?: boolean }) => {
        void p;
        void _opts;
        const state: OpenedFile = { closed: false, closeCalls: 0 };
        opened.push(state);
        let pos = 0;
        const handle: MockHandle = {
          read: async (buf: Uint8Array) => {
            if (hang) return new Promise<null>(() => {});
            if (pos >= BYTES.byteLength) return null;
            const n = Math.min(buf.byteLength, BYTES.byteLength - pos);
            buf.set(BYTES.subarray(pos, pos + n), 0);
            pos += n;
            return n;
          },
          seek: async (offset: number, _whence: string) => {
            void _whence;
            pos = offset;
            return offset;
          },
          close: () => {
            state.closed = true;
            state.closeCalls += 1;
          },
        };
        return handle;
      },
    };
    (globalThis as unknown as { Deno?: unknown }).Deno = mock as unknown;
    return { statCalls, opened };
  }

  it("streams the full body with full size + mtime, then closes", async () => {
    const { opened } = installMock();
    const entry = await createDenoLoader("/base").load("hello.txt");
    expect(entry?.size).toBe(BYTES.byteLength);
    expect(entry?.mtime).toEqual(MTIME);
    expect(entry?.body).toBeInstanceOf(ReadableStream);
    await expect(streamToBytes(entry?.body)).resolves.toEqual(BYTES);
    expect(opened[0]?.closed).toBe(true);
  });

  it("seeks and streams exactly bytes [start..end] on range, keeping full size", async () => {
    const { opened } = installMock();
    const entry = await createDenoLoader("/base").load("hello.txt", { start: 2, end: 5 });
    expect(entry?.size).toBe(BYTES.byteLength);
    await expect(streamToBytes(entry?.body)).resolves.toEqual(BYTES.slice(2, 6));
    expect(opened[0]?.closed).toBe(true);
  });

  it("closes the handle when the stream is cancelled mid-read", async () => {
    const { opened } = installMock({ hang: true });
    const entry = await createDenoLoader("/base").load("hello.txt");
    const stream = entry?.body as unknown as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    await reader.cancel();
    reader.releaseLock();
    expect(opened[0]?.closed).toBe(true);
  });

  it("returns undefined for missing files, non-files, and traversal", async () => {
    installMock({ exists: false });
    await expect(createDenoLoader("/base").load("missing.txt")).resolves.toBeUndefined();

    installMock({ isFile: false });
    await expect(createDenoLoader("/base").load("dir")).resolves.toBeUndefined();

    const { statCalls } = installMock();
    await expect(createDenoLoader("/base").load("../outside.txt")).resolves.toBeUndefined();
    await expect(createDenoLoader("/base").load("a\\b.txt")).resolves.toBeUndefined();
    expect(statCalls).toEqual([]);
  });

  it("returns undefined when Deno is unavailable", async () => {
    (globalThis as unknown as { Deno?: unknown }).Deno = undefined;
    await expect(createDenoLoader("/base").load("hello.txt")).resolves.toBeUndefined();
  });
});
