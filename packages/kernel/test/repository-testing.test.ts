import { describe, it, expect } from "vitest";
import { module } from "../src/module.js";
import { injectable, inject, controller, get } from "../src/decorators.js";
import { Application } from "../src/application.js";
import { MemoryRepository, MemoryUnitOfWork } from "../src/repository.js";
import { ConflictException } from "../src/exceptions.js";
import {
  testApp,
  testPrincipal,
  createTestContext,
  fixedClock,
  counterIds,
  fakeFetch,
} from "../src/testing.js";
import { roleGuard } from "../src/authorization.js";
import { runGuards } from "../src/guards.js";

interface Account {
  id: string;
  version: number;
  balance: number;
}

describe("kernel repository ports (P5.1)", () => {
  it("saves with optimistic concurrency, copies on read/write", async () => {
    const repo = new MemoryRepository<Account>();
    const created = await repo.save({ id: "a", version: 0, balance: 100 });
    expect(created.version).toBe(0);
    const loaded = (await repo.findById("a")) as Account;
    loaded.balance = 999;
    expect((await repo.findById("a"))?.balance).toBe(100);
    const updated = await repo.save({ id: "a", version: 0, balance: 50 });
    expect(updated.version).toBe(1);
    expect(updated.balance).toBe(50);
    await expect(repo.save({ id: "a", version: 0, balance: 1 })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await repo.findAll()).toHaveLength(1);
    expect(repo.size).toBe(1);
    expect(await repo.delete("a")).toBe(true);
    expect(await repo.delete("a")).toBe(false);
    expect(await repo.findById("a")).toBeUndefined();
  });

  it("unit of work runs the function", async () => {
    const uow = new MemoryUnitOfWork();
    expect(await uow.run(() => 42)).toBe(42);
  });
});

describe("kernel testing helpers (P6)", () => {
  it("testApp boots modules; routes execute via fetch", async () => {
    @injectable()
    class Svc {
      hello(): string {
        return "hi";
      }
    }
    @controller("/t")
    class Ctrl {
      constructor(@inject(Svc) private svc: Svc) {}
      @get("/hello")
      hello(c: { json: (v: unknown) => Response }): Response {
        return c.json({ msg: this.svc.hello() });
      }
    }
    @module({ providers: [Svc], controllers: [Ctrl] })
    class Mod {}
    const app = await testApp(Mod);
    const res = await app.fetch(new Request("http://localhost/t/hello"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ msg: "hi" });
    await app.start();
    await app.stop();
  });

  it("createTestContext seeds the shared principal for guards", async () => {
    const ctx = createTestContext({
      principal: testPrincipal({ roles: ["admin"], tenant: "acme" }),
    });
    expect(await runGuards([roleGuard("admin")], ctx)).toBe(true);
    const anon = createTestContext();
    expect(await runGuards([roleGuard("admin")], anon)).toBe(false);
  });

  it("fakes: clock, ids, fetch", async () => {
    const clock = fixedClock(100);
    clock.advance(50);
    expect(clock.now()).toBe(150);
    const ids = counterIds("u");
    expect([ids.next(), ids.next()]).toEqual(["u-1", "u-2"]);
    const fake = fakeFetch();
    fake.respondWith([new Response("one"), new Error("down")]);
    expect(await (await fake.fetch("https://x.example.com/a")).text()).toBe("one");
    await expect(fake.fetch("https://x.example.com/b")).rejects.toThrow("down");
    expect(await (await fake.fetch("https://x.example.com/c")).status).toBe(500);
    expect(fake.calls.map((c) => c.url)).toEqual([
      "https://x.example.com/a",
      "https://x.example.com/b",
      "https://x.example.com/c",
    ]);
  });
});
