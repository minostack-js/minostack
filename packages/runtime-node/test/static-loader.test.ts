import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeLoader } from "../src/index.js";

async function streamToBytes(body: unknown): Promise<Uint8Array> {
  const res = new Response(body as BodyInit);
  return new Uint8Array(await res.arrayBuffer());
}

describe("runtime-node createNodeLoader (streaming)", () => {
  let dir: string;
  const content = new TextEncoder().encode("0123456789abcdef");

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mino-node-loader-"));
    await writeFile(join(dir, "hello.txt"), content);
    await mkdir(join(dir, "sub"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("streams the full body with full size + mtime", async () => {
    const loader = createNodeLoader(dir);
    const entry = await loader.load("hello.txt");
    expect(entry).toBeDefined();
    expect(entry?.size).toBe(content.byteLength);
    expect(entry?.mtime).toBeInstanceOf(Date);
    expect(entry?.body).toBeInstanceOf(ReadableStream);
    await expect(streamToBytes(entry?.body)).resolves.toEqual(content);
  });

  it("streams exactly bytes [start..end] on range, keeping the full size", async () => {
    const loader = createNodeLoader(dir);
    const entry = await loader.load("hello.txt", { start: 2, end: 5 });
    expect(entry?.size).toBe(content.byteLength);
    expect(entry?.body).toBeInstanceOf(ReadableStream);
    await expect(streamToBytes(entry?.body)).resolves.toEqual(content.slice(2, 6));
  });

  it("returns undefined for missing files, directories, and escapes", async () => {
    const loader = createNodeLoader(dir);
    await expect(loader.load("missing.txt")).resolves.toBeUndefined();
    await expect(loader.load("sub")).resolves.toBeUndefined();
    await expect(loader.load("../outside.txt")).resolves.toBeUndefined();
  });
});
