/**
 * Application — deterministic bootstrap for enterprise apps.
 * Lifecycle per §23, module graph per §21, execution context per §24.
 */

import { Container, getInjectTokens, getParamTypes } from "./container.js";
import { getModuleMetadata, type ModuleClass } from "./module.js";
import {
  getControllerOptions,
  getRoutes,
  getGuards,
  getInterceptors,
  getPipes,
  type RouteMeta,
} from "./decorators.js";
import { getTokenName, type Token } from "./token.js";
import { normalizeProvider } from "./provider.js";
import { Mino, type Handler } from "@minostack/mino";
import { ExecutionContext } from "./execution-context.js";
import {
  runGuards,
  runInterceptors,
  runPipes,
  type Guard,
  type Interceptor,
  type PipeTransform,
} from "./guards.js";
import { callOnDestroy, callOnInit, callOnStart, callOnStop } from "./lifecycle.js";
import { getTracer, resolveTraceContext } from "./observability.js";
import { defaultExceptionFilter, type ExceptionFilter } from "./exceptions.js";

export type ApplicationOptions = {
  /** Global prefix for all routes (forwarded to Mino) */
  prefix?: string;
  /** Exception filter */
  exceptionFilter?: ExceptionFilter;
  /** Whether to enable tracing */
  tracing?: boolean;
};

export class Application {
  private container: Container;
  private mino: Mino;
  private modules = new Set<ModuleClass>();
  private providers = new Map<Token, unknown>(); // token -> instance (after init)
  private controllers = new Set<object>();
  private controllerTokens = new Set<Token>();
  private instances: unknown[] = []; // ordered for lifecycle
  private exceptionFilter: ExceptionFilter;
  private opts: ApplicationOptions;
  private started = false;

  private constructor(
    private rootModule: ModuleClass,
    opts: ApplicationOptions = {},
  ) {
    this.opts = opts;
    this.container = new Container();
    this.mino = new Mino({ prefix: opts.prefix });
    this.exceptionFilter = opts.exceptionFilter ?? defaultExceptionFilter;
  }

  static async create(
    rootModule: ModuleClass,
    opts: ApplicationOptions = {},
  ): Promise<Application> {
    const app = new Application(rootModule, opts);
    await app.init();
    return app;
  }

  private async init(): Promise<void> {
    // 1. Module Discovery — DFS deterministic
    const visited = new Set<ModuleClass>();
    const order: ModuleClass[] = [];
    const stack: ModuleClass[] = [this.rootModule];

    const visit = (mod: ModuleClass, path: ModuleClass[] = []) => {
      if (path.includes(mod)) {
        const chain = [...path, mod].map((m) => m.name).join(" -> ");
        throw new Error(`Circular module dependency: ${chain}`);
      }
      if (visited.has(mod)) return;
      visited.add(mod);
      const meta = getModuleMetadata(mod);
      if (!meta)
        throw new Error(
          `Module ${mod.name} is missing @module decorator. Did you forget @module({...})?`,
        );
      // Visit imports first (depth-first, preserve order)
      for (const imp of meta.imports ?? []) {
        visit(imp, [...path, mod]);
      }
      order.push(mod);
    };

    visit(this.rootModule);
    // `order` now is post-order (dependencies before dependents) — good for provider registration
    // But for deterministic, we want imports before dependents, which post-order gives.
    for (const mod of order) this.modules.add(mod);

    // 2. Provider Registration — deterministic order per module graph, with strict exports tracking
    // Track ownership for strict boundary enforcement
    const providerOwner = new Map<Token, ModuleClass>();
    const controllerOwner = new Map<Token, ModuleClass>();
    const exportedSet = new Set<Token>();
    // First collect exported tokens union
    for (const mod of order) {
      const meta = getModuleMetadata(mod);
      for (const exp of meta?.exports ?? []) {
        exportedSet.add(exp as Token);
      }
    }
    for (const mod of order) {
      const meta = getModuleMetadata(mod);
      if (!meta) continue;
      for (const prov of meta.providers ?? []) {
        const normalized = normalizeProvider(prov as never);
        const tok = normalized.token as Token;
        // Detect duplicate ownership across modules (strict: must be exported to be re-provided)
        if (providerOwner.has(tok) && !exportedSet.has(tok)) {
          // Allow same token only if original was exported; otherwise it's hidden private duplicate
          // For now, let container throw duplicate error for determinism
        }
        // If provider is a class, check for injectable scope override
        if (normalized.kind === "class") {
          const ctor = normalized.useClass as unknown as { __scope?: string };
          if (ctor.__scope && ctor.__scope !== normalized.scope) {
            const hasExplicitScope = (prov as { scope?: string }).scope !== undefined;
            if (!hasExplicitScope) normalized.scope = ctor.__scope as never;
          }
        }
        this.container.register(normalized as never);
        providerOwner.set(tok, mod);
        // Also map class token to owner if useClass differs from token (e.g. string token -> class)
        if (normalized.kind === "class" && tok !== (normalized.useClass as unknown as Token)) {
          // For string/symbol tokens backed by class, track class as well for dep validation
        }
      }
    }

    // 3. Controller instantiation — controllers are not registered as providers by default unless also in providers
    for (const mod of order) {
      const meta = getModuleMetadata(mod);
      for (const ctrl of meta?.controllers ?? []) {
        const tok = ctrl as unknown as Token;
        controllerOwner.set(tok, mod);
        this.controllerTokens.add(tok);
        if (!this.container.has(tok)) {
          // Respect @injectable scope on controller if present
          const scope = (ctrl as unknown as { __scope?: string }).__scope;
          if (scope) {
            // Register with scope from decorator
            this.container.register({
              token: tok,
              useClass: ctrl as unknown as new (...args: unknown[]) => unknown,
              scope: scope as never,
            } as never);
          } else {
            this.container.register(ctrl as unknown as never);
          }
        } else {
          // Already registered as provider; ensure controllerOwner still tracked
        }
      }
    }

    // 3b. Strict exports validation — ensure cross-module deps are exported
    const getDepsForToken = (tok: Token): Token[] => {
      // For class providers/controllers, resolve constructor deps; for factory/existing, use inject
      const provider = (
        this.container as unknown as {
          providers: Map<Token, { inject?: Token[]; useClass?: unknown }>;
        }
      ).providers?.get(tok) as
        { inject?: Token[]; useClass?: new (...args: unknown[]) => unknown } | undefined;
      // Try to find class constructor (for bare class tokens)
      let ctor: unknown = undefined;
      if (provider?.useClass) ctor = provider.useClass;
      else if (typeof tok === "function") ctor = tok;
      if (ctor && typeof ctor === "function") {
        const explicit = provider?.inject;
        if (explicit && explicit.length > 0) return explicit as Token[];
        const injectMeta = getInjectTokens(ctor as object);
        if (injectMeta && injectMeta.length > 0) return injectMeta as Token[];
        const paramTypes = getParamTypes(ctor as object);
        if (paramTypes && paramTypes.length > 0) {
          // Filter out primitives that container would fail on: Object, String, Number, Boolean, Array
          const filtered = (paramTypes as unknown[]).filter((t) => {
            return t !== Object && t !== String && t !== Number && t !== Boolean && t !== Array;
          });
          return filtered as unknown as Token[];
        }
      }
      if (provider?.inject) return provider.inject as Token[];
      return [];
    };
    // For each consumer (provider or controller), validate its deps are visible
    const allConsumers: { token: Token; owner: ModuleClass | undefined }[] = [
      ...[...providerOwner.entries()].map(([tok, owner]) => ({ token: tok, owner })),
      ...[...controllerOwner.entries()].map(([tok, owner]) => ({ token: tok, owner })),
    ];
    for (const { token: consumerTok, owner: consumerOwner } of allConsumers) {
      if (!consumerOwner) continue;
      const deps = getDepsForToken(consumerTok);
      for (const dep of deps) {
        const depOwner = providerOwner.get(dep);
        if (!depOwner) continue; // external or value token not tracked — assume visible
        if (depOwner === consumerOwner) continue; // same module, private allowed
        if (exportedSet.has(dep)) continue; // exported, allowed
        // Check if dep is provided by ancestor that is imported transitively?
        // For strict union model, exportedSet check already covers it. If not exported, fail.
        throw new Error(
          `Module "${consumerOwner.name}" depends on provider "${getTokenName(dep)}" from module "${depOwner.name}" but it is not exported. ` +
            `Add it to exports of "${depOwner.name}" or import the module that exports it.`,
        );
      }
    }

    // 4. Instantiate all providers + controllers (eager for lifecycle — only singleton)
    // Collect all tokens to instantiate
    const allTokens: Token[] = [];
    for (const mod of order) {
      const meta = getModuleMetadata(mod);
      for (const prov of meta?.providers ?? []) {
        const tok = typeof prov === "function" ? (prov as Token) : (prov as { token: Token }).token;
        allTokens.push(tok);
      }
      for (const ctrl of meta?.controllers ?? []) {
        allTokens.push(ctrl as Token);
      }
    }

    // Deduplicate
    const uniqTokens = [...new Set(allTokens)];
    for (const tok of uniqTokens) {
      // Only eager-instantiate singleton scoped providers at bootstrap; request/transient are lazy per-request
      const provider = (
        this.container as unknown as { providers: Map<Token, { scope?: string }> }
      ).providers?.get(tok) as { scope?: string } | undefined;
      const scope = provider?.scope ?? "singleton";
      if (scope !== "singleton") {
        // For singleton controllers that depend on request/transient, they will be lazily resolved per-request via createRequestScope
        // Skip eager instantiation for non-singleton
        continue;
      }
      try {
        const instance = await this.container.get(tok);
        this.instances.push(instance);
        if (typeof tok === "function" && (instance as object) instanceof (tok as never)) {
          this.controllers.add(instance as object);
        } else {
          const ctrlOpts = getControllerOptions((instance as object)?.constructor as object);
          if (ctrlOpts !== undefined) this.controllers.add(instance as object);
        }
      } catch (e) {
        throw new Error(
          `Failed to instantiate provider ${getTokenName(tok)}: ${(e as Error).message}`,
        );
      }
    }
    // Ensure controllers that are singleton are all instantiated; request/transient controllers will be lazily created per request
    // For controllers that are non-singleton but singleton still needs to be in controllers set lazily — will be added on first request via interceptor
    // For now, also instantiate controllers that are singleton but were skipped due to being controllerOwner not in allTokens? They are in allTokens
    // If any singleton controller was skipped because its provider scope was singleton but we skipped due to being non-singleton? No.

    // 5. Call OnInit in registration order
    await callOnInit(this.instances);

    // 6. Register routes from controllers onto Mino
    this.registerControllerRoutes();

    // 7. Setup Mino error handling to use exception filter
    this.mino.onError(async (err, c) => {
      const res = await this.exceptionFilter(err, { request: c.req });
      return res;
    });
  }

  private registerControllerRoutes(): void {
    // Use controllerTokens set to include request/transient controllers that were not eagerly instantiated
    for (const token of this.controllerTokens) {
      const ctor = token as unknown as { name: string } & object;
      if (typeof ctor !== "function") continue;
      const ctrlOpts = getControllerOptions(ctor as object);
      if (!ctrlOpts) continue;
      const basePath = ctrlOpts.path ?? "";
      const routes = getRoutes(ctor as object) ?? [];
      // Also check prototype routes stored via __routes
      const protoRoutes = (ctor as unknown as { __routes?: RouteMeta[] }).__routes;
      const allRoutes = [...routes];
      if (protoRoutes) {
        for (const r of protoRoutes) {
          if (
            !allRoutes.some(
              (x) => x.handlerName === r.handlerName && x.method === r.method && x.path === r.path,
            )
          ) {
            allRoutes.push(r);
          }
        }
      }

      // Determine scope for this controller to decide per-request resolution
      const providerMeta = (
        this.container as unknown as { providers: Map<Token, { scope?: string }> }
      ).providers?.get(token as unknown as Token) as { scope?: string } | undefined;
      const scope = providerMeta?.scope ?? "singleton";
      const isSingleton = scope === "singleton";

      for (const route of allRoutes) {
        const method = route.method;
        const routePath = this.joinPaths(basePath, route.path);
        const handlerName = route.handlerName;
        // For singleton, we can cache the instance; for request/transient we resolve per request
        // Find cached singleton instance if available
        const cachedSingleton = isSingleton
          ? [...this.controllers].find((inst) => (inst as object).constructor === ctor)
          : undefined;

        const handler: Handler = async (c, _next) => {
          // Resolve controller instance respecting scope
          let instance: object;
          let requestContainer: Container | undefined;
          if (isSingleton) {
            if (cachedSingleton) {
              instance = cachedSingleton as object;
            } else {
              instance = (await this.container.get(token as unknown as Token)) as object;
            }
          } else {
            requestContainer = this.container.createRequestScope();
            instance = (await requestContainer.get(token as unknown as Token)) as object;
          }
          const originalMethod = (instance as Record<string | symbol, unknown>)[handlerName];
          if (typeof originalMethod !== "function") {
            console.warn(
              `[kernel] Controller ${(ctor as { name: string }).name} route ${String(handlerName)} is not a function, skipping`,
            );
            return c.json({ error: "Not Found", status: 404 }, 404);
          }
          // Build ExecutionContext — fix module name bug: use ctor.name not ctor.constructor.name
          const trace = this.opts.tracing
            ? resolveTraceContext(c.req.headers.get("traceparent"))
            : undefined;
          const tracer = getTracer();
          const span = tracer.startSpan(`controller.${String(handlerName)}`, { kind: "server" });
          const ctx = new ExecutionContext({
            request: c.req,
            route: { method, path: routePath },
            module: { name: (ctor as { name: string }).name },
            controller: {
              instance,
              method: String(handlerName),
              handler: originalMethod as (...args: unknown[]) => unknown,
            },
            container: requestContainer ?? this.container,
            traceId: trace?.traceId,
          });

          // Guards — combine class-level + method-level
          const classGuards = getGuards(ctor as object) ?? [];
          const methodGuardsViaProto = (
            ctor as unknown as { __methodGuards?: Map<string, unknown> }
          ).__methodGuards?.get(String(handlerName)) as unknown[] | undefined;
          const methodGuardsViaInstance = (
            instance as unknown as { __methodGuards?: Map<string, unknown> }
          ).__methodGuards?.get(String(handlerName)) as unknown[] | undefined;
          const methodGuards = methodGuardsViaProto ?? methodGuardsViaInstance;
          const allGuardTypes = [...classGuards, ...(methodGuards ?? [])];
          if (allGuardTypes.length > 0) {
            const guards: Guard[] = [];
            const guardContainer = requestContainer ?? this.container;
            for (const g of allGuardTypes) {
              if (typeof g === "function") {
                try {
                  const inst = await guardContainer.get(g as Token);
                  guards.push(inst as Guard);
                } catch {
                  guards.push(new (g as new () => Guard)());
                }
              } else {
                guards.push(g as Guard);
              }
            }
            const can = await runGuards(guards, ctx);
            if (!can) {
              span.setStatus({ code: 403, message: "Guard rejected" });
              span.end();
              return c.json({ error: "Forbidden", status: 403 }, 403);
            }
          }

          // Pipes — combine class-level + method-level (was dead before)
          const classPipes = getPipes(ctor as object) ?? [];
          const methodPipesViaProto = (
            ctor as unknown as { __methodPipes?: Map<string, unknown> }
          ).__methodPipes?.get(String(handlerName)) as unknown[] | undefined;
          const methodPipesViaInstance = (
            instance as unknown as { __methodPipes?: Map<string, PipeTransform> }
          ).__methodPipes?.get(String(handlerName)) as unknown[] | undefined;
          const methodPipes = methodPipesViaProto ?? methodPipesViaInstance;
          const allPipeTypes = [...classPipes, ...(methodPipes ?? [])];
          if (allPipeTypes.length > 0) {
            const pipes: PipeTransform[] = [];
            const pipeContainer = requestContainer ?? this.container;
            for (const p of allPipeTypes) {
              if (typeof p === "function") {
                try {
                  const inst = await pipeContainer.get(p as Token);
                  pipes.push(inst as PipeTransform);
                } catch {
                  // If pipe is a class not registered, instantiate directly
                  const PipeClass = p as unknown as new () => PipeTransform;
                  pipes.push(new PipeClass());
                }
              } else {
                pipes.push(p as PipeTransform);
              }
            }
            // For v0.1, pipes transform the request context's validated data or raw request
            // We use "custom" type and pass the Context as value; pipes can read c.req, c.params, etc.
            // If a pipe throws, it will bubble to exception filter (400/422)
            const pipeValue =
              (c as unknown as { valid?: (k: string) => unknown }).valid?.("json") ?? c.req;
            await runPipes(pipes, pipeValue, {
              type: "custom",
              metatype: ctor,
              data: String(handlerName),
            });
          }

          // Interceptors — combine class-level + method-level
          const classInterceptors = getInterceptors(ctor as object) ?? [];
          const methodInterceptorsViaProto = (
            ctor as unknown as { __methodInterceptors?: Map<string, unknown> }
          ).__methodInterceptors?.get(String(handlerName)) as unknown[] | undefined;
          const methodInterceptorsViaInstance = (
            instance as unknown as { __methodInterceptors?: Map<string, unknown> }
          ).__methodInterceptors?.get(String(handlerName)) as unknown[] | undefined;
          const methodInterceptors = methodInterceptorsViaProto ?? methodInterceptorsViaInstance;
          const allInterceptorTypes = [...classInterceptors, ...(methodInterceptors ?? [])];
          const interceptors: Interceptor[] = [];
          const interceptorContainer = requestContainer ?? this.container;
          if (allInterceptorTypes.length > 0) {
            for (const ii of allInterceptorTypes) {
              if (typeof ii === "function") {
                try {
                  const inst = await interceptorContainer.get(ii as Token);
                  interceptors.push(inst as Interceptor);
                } catch {
                  interceptors.push(new (ii as new () => Interceptor)());
                }
              } else {
                interceptors.push(ii as Interceptor);
              }
            }
          }

          const exec = async (): Promise<Response> => {
            const result = await (originalMethod as unknown as (c: unknown) => unknown).call(
              instance,
              c,
            );
            if (result instanceof Response) return result;
            if (result === undefined || result === null) {
              if (c.res) return c.res;
              return c.json({ ok: true });
            }
            if (typeof result === "object") {
              return c.json(result);
            }
            return c.text(String(result));
          };

          try {
            const response =
              interceptors.length > 0
                ? await runInterceptors(interceptors, ctx, exec)
                : await exec();
            span.end();
            return response;
          } catch (e) {
            span.setStatus({ code: 500, message: (e as Error).message });
            span.end();
            throw e;
          }
        };

        const normalizedPath = routePath.startsWith("/") ? routePath : `/${routePath}`;
        if (method === "ALL") {
          this.mino.all(normalizedPath, handler as never);
        } else {
          this.mino.route(method, normalizedPath, handler as never);
        }
      }
    }
  }

  private joinPaths(a: string, b: string): string {
    const left = a.endsWith("/") ? a.slice(0, -1) : a;
    const right = b.startsWith("/") ? b : `/${b}`;
    if (!left) return right;
    if (right === "/") return left || "/";
    return `${left}${right}`;
  }

  // ─────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────

  get<T>(token: Token<T>): Promise<T> {
    return this.container.get(token);
  }

  getSync<T>(token: Token<T>): T {
    return this.container.getSync(token);
  }

  getMino(): Mino {
    return this.mino;
  }

  getContainer(): Container {
    return this.container;
  }

  get fetch(): (req: Request) => Promise<Response> {
    return this.mino.fetch.bind(this.mino);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await callOnStart(this.instances);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await callOnStop(this.instances);
    await callOnDestroy(this.instances);
    this.started = false;
  }

  /**
   * Create a request-scoped container for handling a single request.
   * Per §22: request scope support.
   */
  createRequestContext(): { container: Container; close: () => Promise<void> } {
    const child = this.container.createRequestScope();
    return {
      container: child,
      close: async () => {
        await child.destroyRequestScope();
      },
    };
  }
}
