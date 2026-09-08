import { describe, it, expect, vi } from "vitest";
import { Mino } from "@minostack/mino";
import { serve, toFetchHandler } from "../src/index.js";

describe("runtime-deno", () => {
  it("toFetchHandler returns fetch function", async () => {
    const app = new Mino();
    app.get("/", (c) => c.text("hi"));
    const handler = toFetchHandler(app);
    const res = await handler(new Request("http://localhost/"));
    expect(await res.text()).toBe("hi");
  });

  it("serve throws when not on Deno", () => {
    const app = new Mino();
    const origDeno = (globalThis as unknown as { Deno?: unknown }).Deno;
    (globalThis as unknown as { Deno?: unknown }).Deno = undefined;
    expect(() => serve(app, { port: 3000 })).toThrow(/Deno runtime not available/);
    (globalThis as unknown as { Deno?: unknown }).Deno = origDeno;
  });

  it("serve uses Deno.serve when available", () => {
    const app = new Mino();
    app.get("/", (c) => c.text("deno"));
    const mockServer = {
      finished: Promise.resolve(),
      shutdown: vi.fn(),
      addr: { hostname: "0.0.0.0", port: 8000 },
    };
    const mockDeno = {
      serve: vi.fn((_opts: unknown, _handler: unknown) => mockServer),
    };
    const origDeno = (globalThis as unknown as { Deno?: unknown }).Deno;
    (globalThis as unknown as { Deno?: unknown }).Deno = mockDeno as unknown;
    const server = serve(app, { port: 8000 });
    expect(mockDeno.serve).toHaveBeenCalled();
    expect(server).toBe(mockServer);
    (globalThis as unknown as { Deno?: unknown }).Deno = origDeno;
  });
});
