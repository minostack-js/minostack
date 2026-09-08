import { describe, it, expect, vi } from "vitest";
import { Mino } from "@minostack/mino";
import { serve, toFetchHandler } from "../src/index.js";

describe("runtime-bun", () => {
  it("toFetchHandler returns fetch function", async () => {
    const app = new Mino();
    app.get("/", (c) => c.text("hi"));
    const handler = toFetchHandler(app);
    const res = await handler(new Request("http://localhost/"));
    expect(await res.text()).toBe("hi");
  });

  it("serve throws when not on Bun", () => {
    const app = new Mino();
    // Ensure global Bun is undefined for this test
    const origBun = (globalThis as unknown as { Bun?: unknown }).Bun;
    (globalThis as unknown as { Bun?: unknown }).Bun = undefined;
    expect(() => serve(app, { port: 3000 })).toThrow(/Bun runtime not available/);
    (globalThis as unknown as { Bun?: unknown }).Bun = origBun;
  });

  it("serve uses Bun.serve when available", async () => {
    const app = new Mino();
    app.get("/", (c) => c.text("bun"));
    const mockServer = { port: 3000, hostname: "0.0.0.0", stop: vi.fn() };
    const mockBun = {
      serve: vi.fn((opts: { fetch: (req: Request) => Promise<Response> }) => {
        // test that fetch works
        // we don't actually call it, just return mock
        void opts.fetch;
        return mockServer;
      }),
    };
    const origBun = (globalThis as unknown as { Bun?: unknown }).Bun;
    (globalThis as unknown as { Bun?: unknown }).Bun = mockBun as unknown;
    const server = serve(app, { port: 3000 });
    expect(mockBun.serve).toHaveBeenCalled();
    expect(server).toBe(mockServer);
    (globalThis as unknown as { Bun?: unknown }).Bun = origBun;
  });
});
