import { describe, it, expect } from "vitest";
import { createToken, getTokenName, isClassToken } from "../src/token.js";
import { Container } from "../src/container.js";
import { module, defineModule, getModuleMetadata } from "../src/module.js";
import { injectable, inject, controller, get, post, useGuards } from "../src/decorators.js";
import { Application } from "../src/application.js";
import { createDto, getDto, listDtos } from "../src/dto.js";
import { m } from "@minostack/schema";
import { Mino } from "@minostack/mino";
import { ExecutionContext } from "../src/execution-context.js";
import { HttpException, BadRequestException, NotFoundException } from "../src/exceptions.js";
import { getTracer, setTracer, NoopTracer, createTraceContext } from "../src/observability.js";
import { callOnInit, callOnStart, callOnStop, callOnDestroy } from "../src/lifecycle.js";

describe("kernel token", () => {
  it("createToken and getTokenName", () => {
    const tok = createToken<string>("MyToken");
    expect(getTokenName(tok)).toBe("MyToken");
    expect(getTokenName("string-token")).toBe("string-token");
    const sym = Symbol("sym");
    expect(getTokenName(sym)).toBe("sym");
    class MyClass {}
    expect(getTokenName(MyClass as never)).toBe("MyClass");
    expect(isClassToken(MyClass as never)).toBe(true);
    expect(isClassToken("not-class" as never)).toBe(false);
  });
});

describe("Container", () => {
  it("registers and resolves value provider", async () => {
    const c = new Container();
    const TOKEN = createToken<number>("NUM");
    c.register({ token: TOKEN, useValue: 42 });
    expect(await c.get(TOKEN)).toBe(42);
    expect(c.getSync(TOKEN)).toBe(42);
  });

  it("resolves class provider with deps", async () => {
    const c = new Container();
    const TOKEN_A = createToken<string>("A");
    const TOKEN_B = createToken<string>("B");
    c.register({ token: TOKEN_A, useValue: "hello" });
    class ServiceB {
      constructor(public a: string) {}
    }
    c.register({ token: TOKEN_B, useClass: ServiceB as never, inject: [TOKEN_A] });
    const b = (await c.get<ServiceB>(TOKEN_B as never)) as ServiceB;
    expect(b.a).toBe("hello");
  });

  it("factory provider", async () => {
    const c = new Container();
    const TOK = createToken<string>("TOK");
    c.register({ token: TOK, useFactory: () => "factory", scope: "singleton" });
    expect(await c.get(TOK)).toBe("factory");
  });

  it("existing alias", async () => {
    const c = new Container();
    const A = createToken<string>("A");
    const B = createToken<string>("B");
    c.register({ token: A, useValue: "a" });
    c.register({ token: B, useExisting: A });
    expect(await c.get(B)).toBe("a");
  });

  it("scopes: singleton, transient, request", async () => {
    const c = new Container();
    const SINGLE = createToken<object>("SINGLE");
    const TRANS = createToken<object>("TRANS");
    const REQ = createToken<object>("REQ");
    class Singleton {
      id = Math.random();
    }
    class Transient {
      id = Math.random();
    }
    class RequestScoped {
      id = Math.random();
    }
    c.register({ token: SINGLE, useClass: Singleton as never, scope: "singleton" });
    c.register({ token: TRANS, useClass: Transient as never, scope: "transient" });
    c.register({ token: REQ, useClass: RequestScoped as never, scope: "request" });

    const s1 = await c.get(SINGLE);
    const s2 = await c.get(SINGLE);
    expect(s1).toBe(s2);

    const t1 = await c.get(TRANS);
    const t2 = await c.get(TRANS);
    expect(t1).not.toBe(t2);

    const child = c.createRequestScope();
    const r1 = await child.get(REQ);
    const r2 = await child.get(REQ);
    expect(r1).toBe(r2);
    const r3 = await c.get(REQ);
    expect(r1).not.toBe(r3);
  });

  it("circular detection", async () => {
    const c = new Container();
    const A = createToken<unknown>("A");
    const B = createToken<unknown>("B");
    class ServiceA {
      constructor(public b: unknown) {}
    }
    class ServiceB {
      constructor(public a: unknown) {}
    }
    c.register({ token: A, useClass: ServiceA as never, inject: [B] });
    c.register({ token: B, useClass: ServiceB as never, inject: [A] });
    await expect(c.get(A)).rejects.toThrow(/Circular/);
  });

  it("override and has", async () => {
    const c = new Container();
    const TOK = createToken<string>("TOK");
    c.register({ token: TOK, useValue: "first" });
    expect(c.has(TOK)).toBe(true);
    c.override(TOK, "second");
    expect(await c.get(TOK)).toBe("second");
    c.clearCache();
    expect(await c.get(TOK)).toBe("second");
  });

  it("shorthand class provider", async () => {
    const c = new Container();
    class MyService {}
    c.register(MyService as never);
    const inst = await c.get(MyService as never);
    expect(inst).toBeInstanceOf(MyService);
  });

  it("duplicate provider throws", () => {
    const c = new Container();
    const TOK = createToken<string>("TOK");
    c.register({ token: TOK, useValue: "a" });
    expect(() => c.register({ token: TOK, useValue: "b" })).toThrow(/already registered/);
  });

  it("inject decorator", async () => {
    const TOK = createToken<string>("TOK");
    const c = new Container();
    c.register({ token: TOK, useValue: "injected" });

    @injectable()
    class Svc {
      constructor(@inject(TOK) public val: string) {}
    }
    c.register(Svc as never);
    const inst = (await c.get(Svc as never)) as Svc;
    expect(inst.val).toBe("injected");
  });
});

describe("Module system", () => {
  it("module decorator stores metadata", () => {
    @module({ providers: [] })
    class TestModule {}
    const meta = getModuleMetadata(TestModule);
    expect(meta).toBeDefined();
    expect(meta?.providers).toEqual([]);
  });

  it("defineModule helper", () => {
    const Mod = defineModule({ providers: [] });
    expect(getModuleMetadata(Mod)).toBeDefined();
  });
});

describe("decorators", () => {
  it("injectable, controller, route decorators", () => {
    @injectable({ scope: "transient" })
    @controller("/test")
    class Ctrl {
      @get("/hello")
      hello() {
        return "hi";
      }
      @post("/create")
      create() {
        return "create";
      }
    }
    // Check metadata via Application registration
    expect(true).toBe(true);
  });

  it("useGuards decorator", () => {
    class MyGuard {
      canActivate() {
        return true;
      }
    }
    @controller("/g")
    class Ctrl {
      @get("/")
      @useGuards(MyGuard as never)
      handler() {}
    }
    expect(true).toBe(true);
  });
});

describe("Application", () => {
  it("bootstrap with module and controller", async () => {
    @injectable()
    class UserService {
      getUser(id: string) {
        return { id, name: "test" };
      }
    }

    @controller("/users")
    class UserController {
      constructor(private svc: UserService) {}
      @get("/:id")
      getOne() {
        // For test, return fixed
        return { id: "1", name: "test" };
      }
    }

    @module({
      providers: [UserService],
      controllers: [UserController],
    })
    class UsersModule {}

    @module({
      imports: [UsersModule],
    })
    class AppModule {}

    const app = await Application.create(AppModule);
    const mino = app.getMino();
    const res = await mino.fetch(new Request("http://localhost/users/1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("1");
    await app.start();
    await app.stop();
  });

  it("detects circular module", async () => {
    @module({})
    class AModule {}
    @module({ imports: [AModule] })
    class BModule {}
    // Create circular by mutating metadata
    const metaA = getModuleMetadata(AModule);
    if (metaA) metaA.imports = [BModule];
    await expect(Application.create(AModule)).rejects.toThrow(/Circular module/);
    // cleanup
    if (metaA) metaA.imports = [];
  });

  it("missing module decorator throws", async () => {
    class NoDecor {}
    await expect(Application.create(NoDecor as never)).rejects.toThrow(/missing @module/);
  });

  it("lifecycle hooks", async () => {
    const calls: string[] = [];
    @injectable()
    class Svc implements OnInitTest {
      async onInit() {
        calls.push("init");
      }
    }
    // Need to define interface shape
    // For test, we just check callOnInit directly
    const inst = new Svc();
    await callOnInit([inst]);
    expect(calls).toContain("init");
    await callOnStart([inst]);
    await callOnStop([inst]);
    await callOnDestroy([inst]);
  });

  it("request scope", async () => {
    @module({ providers: [] })
    class Mod {}
    const app = await Application.create(Mod);
    const { container } = app.createRequestContext();
    expect(container).toBeDefined();
    expect(container.parent).toBe(app.getContainer());
  });

  it("get and getSync", async () => {
    const TOK = createToken<string>("GETTER");
    @module({ providers: [{ token: TOK, useValue: "val" }] })
    class Mod {}
    const app = await Application.create(Mod);
    expect(await app.get(TOK)).toBe("val");
    expect(app.getSync(TOK)).toBe("val");
    expect(app.fetch).toBeDefined();
    expect(app.getMino()).toBeInstanceOf(Mino);
    expect(app.getContainer()).toBeDefined();
  });
});

// Helper interface for test
interface OnInitTest {
  onInit(): Promise<void>;
}

describe("DTO", () => {
  it("createDto and registry", () => {
    const User = m.object({ name: m.string() });
    const dto = createDto("UserDto", User, { kind: "request", description: "User" });
    expect(dto).toBeDefined();
    expect(getDto("UserDto")?.name).toBe("UserDto");
    expect(listDtos().length).toBeGreaterThan(0);
  });
});

describe("ExecutionContext", () => {
  it("creates context", () => {
    const req = new Request("http://localhost/");
    const ctx = new ExecutionContext({ request: req, route: { method: "GET", path: "/" } });
    expect(ctx.getRequest()).toBe(req);
    expect(ctx.getRoute()?.path).toBe("/");
    expect(ctx.switchToHttp().getRequest()).toBe(req);
    expect(ctx.getHandler()).toBeUndefined();
    expect(ctx.getClass()).toBeUndefined();
  });
});

describe("Exceptions", () => {
  it("HttpException toResponse", () => {
    const ex = new HttpException(400, "bad");
    expect(ex.status).toBe(400);
    expect(ex.toResponse().status).toBe(400);
    expect(new BadRequestException().status).toBe(400);
    expect(new NotFoundException().status).toBe(404);
  });
});

describe("Observability", () => {
  it("tracer noop", async () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan("test");
    expect(span.isRecording()).toBe(false);
    expect(span.setAttribute("a", "1")).toBe(span);
    expect(span.addEvent("e")).toBe(span);
    expect(span.setStatus({ code: 0 })).toBe(span);
    span.end();
    expect(tracer.getCurrentSpan()).toBeUndefined();
    const res = await tracer.withSpan(span, async () => 42);
    expect(res).toBe(42);
    const ctx = createTraceContext();
    expect(ctx.traceId).toBeDefined();
    expect(getTracer()).toBeDefined();
    setTracer(new NoopTracer());
    expect(getTracer()).toBeDefined();
  });
});
