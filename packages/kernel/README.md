# @minostack/kernel

> Deterministic application architecture for Minostack — Module graph, DI Container, Lifecycle, ExecutionContext, Guards/Pipes/Interceptors.

```ts
import { module, injectable, controller, get } from "@minostack/kernel";
import { Application } from "@minostack/kernel";

@injectable()
class UserService {
  find(id: string) {
    return { id, name: "Ada" };
  }
}

@controller("/users")
class UserController {
  constructor(private svc: UserService) {}
  @get("/:id")
  getOne(c: import("@minostack/mino").Context) {
    return c.json(this.svc.find(c.param("id") as string));
  }
}

@module({ providers: [UserService], controllers: [UserController] })
class UsersModule {}

@module({ imports: [UsersModule] })
class AppModule {}

const app = await Application.create(AppModule);
const mino = app.getMino(); // Mino instance with routes registered

// Node
import { serve } from "@minostack/runtime-node";
serve(mino, { port: 3000 });
await app.start();
```

## Concepts

- **Module** — `@module({ imports, providers, controllers, exports })`, deterministic DFS graph, circular detection.
- **Provider** — `Token`, `Provider` (`useClass`/`useValue`/`useFactory`/`useExisting`), scopes `singleton | request | transient`.
- **Container** — `Container` with `get(token)`, `createRequestScope()`, useful errors, circular detection.
- **Lifecycle** — `OnInit`/`OnStart`/`OnStop`/`OnDestroy`, ordered `app.start()`/`app.stop()`.
- **ExecutionContext** — `request`, `route`, `module`, `controller`, `traceId`, for Guards/Interceptors.
- **Guards/Pipes/Interceptors** — `@useGuards`, `@useInterceptors`, `@usePipes`.
- **Authorization** — `roleGuard`/`permissionGuard`/`tenantGuard`/`policyGuard` over the shared Mino principal (`mino/principal`).
- **Repository** — `Repository`/`MemoryRepository` ports with optimistic concurrency, `UnitOfWork`/`MemoryUnitOfWork`.
- **Testing** — `testApp`, `createTestContext`, `testPrincipal`, `fixedClock`, `counterIds`, `fakeFetch`.
- **DTO** — `createDto(name, schema)` — schema-backed, shared with OpenAPI/GraphQL.
- **Observability** — `Tracer`/`Span`/`NoopTracer`, OpenTelemetry-compatible, W3C `traceparent` continue-or-start (`parseTraceparent`, `formatTraceparent`, `resolveTraceContext`).

## Design

- `Mino` owns HTTP, `Kernel` owns application architecture. `Kernel` depends on `Mino` (`Application.getMino()`), `Mino` remains usable standalone.
- Decorators are lowercase (`@module`, `@injectable`, `@controller`, `@get`, `@post`, `@inject`, `@useGuards`) — TypeScript-first, `experimentalDecorators` + `emitDecoratorMetadata` for `@inject` auto-inference, otherwise explicit `@inject(Token)`.
- TypeScript mandatory for development, only built `dist/` is JavaScript.

See `prompt.md` §18-27 for full spec.
