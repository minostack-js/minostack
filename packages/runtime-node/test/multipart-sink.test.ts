/**
 * multipart disk sink (`pipeToFile`): exact bytes + size, missing-dir
 * creation, traversal/control-char sanitization, mid-stream maxBytes breach
 * (413 + no remnant), and source-error cleanup (no remnant).
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pipeToFile } from "../src/index.js";

async function* chunksOf(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) {
    yield data.slice(i, i + size);
  }
}

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mino-sink-"));
}

describe("pipeToFile", () => {
  it("writes bytes exactly and returns the absolute path + size", async () => {
    const dir = await freshDir();
    const data = new Uint8Array([0, 1, 2, 250, 255, 13, 10, 65]);
    const res = await pipeToFile(chunksOf(data, 3), dir, { filename: "a.bin" });
    expect(res.path.startsWith(dir + sep)).toBe(true);
    expect(res.path.endsWith(`${sep}a.bin`)).toBe(true);
    expect(res.size).toBe(data.byteLength);
    expect(new Uint8Array(await readFile(res.path))).toEqual(data);
  });

  it("creates missing nested dirs", async () => {
    const dir = await freshDir();
    const nested = join(dir, "deep", "nested");
    const res = await pipeToFile(chunksOf(new Uint8Array([1, 2]), 1), nested, {
      filename: "n.bin",
    });
    expect(new Uint8Array(await readFile(res.path))).toEqual(new Uint8Array([1, 2]));
  });

  it("sanitizes traversal filenames (confined to dir)", async () => {
    const dir = await freshDir();
    const res = await pipeToFile(chunksOf(new Uint8Array([9]), 1), dir, {
      filename: "../../evil.txt",
    });
    expect(res.path.startsWith(dir + sep)).toBe(true);
    expect(res.path.endsWith(`${sep}evil.txt`)).toBe(true);
    expect(new Uint8Array(await readFile(res.path))).toEqual(new Uint8Array([9]));
  });

  it("sanitizes windows-style traversal and control chars", async () => {
    const dir = await freshDir();
    const win = await pipeToFile(chunksOf(new Uint8Array([1]), 1), dir, {
      filename: "..\\..\\win.txt",
    });
    expect(win.path.startsWith(dir + sep)).toBe(true);
    const ctl = await pipeToFile(chunksOf(new Uint8Array([2]), 1), dir, {
      filename: "fi\0le\x1F.txt",
    });
    expect(ctl.path.endsWith(`${sep}file.txt`)).toBe(true);
  });

  it("falls back to a random name for empty/dotdot filenames", async () => {
    const dir = await freshDir();
    for (const filename of ["", "..", "."]) {
      const res = await pipeToFile(chunksOf(new Uint8Array([5]), 1), dir, { filename });
      expect(res.path.startsWith(dir + sep)).toBe(true);
      expect(new Uint8Array(await readFile(res.path))).toEqual(new Uint8Array([5]));
    }
    expect((await readdir(dir)).length).toBe(3);
  });

  it("uses a random name when filename is omitted", async () => {
    const dir = await freshDir();
    const res = await pipeToFile(chunksOf(new Uint8Array([6, 7]), 2), dir);
    expect(res.size).toBe(2);
    expect(new Uint8Array(await readFile(res.path))).toEqual(new Uint8Array([6, 7]));
  });

  it("enforces maxBytes mid-stream: 413 error + no remnant", async () => {
    const dir = await freshDir();
    const data = new Uint8Array(1000).map((_, i) => i % 256);
    const err = await pipeToFile(chunksOf(data, 100), dir, {
      filename: "big.bin",
      maxBytes: 250,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as unknown as { status?: number }).status).toBe(413);
    expect(await readdir(dir)).toEqual([]);
  });

  it("unlinks the partial file when the source errors", async () => {
    const dir = await freshDir();
    async function* boom(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      throw new Error("boom");
    }
    await expect(pipeToFile(boom(), dir, { filename: "p.bin" })).rejects.toThrow("boom");
    expect(await readdir(dir)).toEqual([]);
  });

  it("writes an empty stream as a zero-byte file", async () => {
    const dir = await freshDir();
    async function* empty(): AsyncGenerator<Uint8Array> {
      // yields nothing
    }
    const res = await pipeToFile(empty(), dir, { filename: "e.bin" });
    expect(res.size).toBe(0);
    expect(new Uint8Array(await readFile(res.path)).byteLength).toBe(0);
  });
});
