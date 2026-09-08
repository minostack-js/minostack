/**
 * Kernel decorators — lowercase, TypeScript-first.
 * Provides: @injectable, @controller, @inject, route decorators, @useGuards / @useInterceptors / @usePipes
 */

import { setInjectTokens } from "./container.js";
import type { Token } from "./token.js";
import type { GuardType, InterceptorType, PipeTransform } from "./guards.js";

// ─────────────────────────────────────────────────────────────────
// @injectable — marks a class as provider
// ─────────────────────────────────────────────────────────────────

export type InjectableOptions = {
  scope?: "singleton" | "request" | "transient";
};

const INJECTABLE_META = new WeakMap<object, InjectableOptions>();

export function getInjectableOptions(target: object): InjectableOptions | undefined {
  return INJECTABLE_META.get(target);
}

export function injectable(options: InjectableOptions = {}): ClassDecorator {
  return (target) => {
    INJECTABLE_META.set(target, options);
    // Store scope on ctor for container to read
    (target as unknown as { __scope?: string }).__scope = options.scope ?? "singleton";
  };
}

// ─────────────────────────────────────────────────────────────────
// @inject — param decorator to specify token for injection
// ─────────────────────────────────────────────────────────────────

export function inject(token: Token): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    // target is prototype for instance members, constructor for ctor params (when decorating ctor param, target is constructor)
    const ctor =
      typeof target === "function" ? target : (target as { constructor: unknown }).constructor;
    const existing = globalInjectMap.get(ctor as object) ?? [];
    // Ensure array length
    while (existing.length <= parameterIndex) existing.push(undefined as unknown as Token);
    existing[parameterIndex] = token;
    globalInjectMap.set(ctor as object, existing);
    // Also set via container helper for direct lookup
    setInjectTokens(ctor as object, existing);
  };
}

const globalInjectMap = new WeakMap<object, Token[]>();

export function getInjectParamTokens(target: object): Token[] | undefined {
  return globalInjectMap.get(target);
}

// ─────────────────────────────────────────────────────────────────
// @controller — marks a class as controller with optional prefix
// ─────────────────────────────────────────────────────────────────

export type ControllerOptions = {
  path?: string;
};

const CONTROLLER_META = new WeakMap<object, ControllerOptions>();

export function getControllerOptions(target: object): ControllerOptions | undefined {
  return CONTROLLER_META.get(target);
}

export function controller(pathOrOptions?: string | ControllerOptions): ClassDecorator {
  const opts: ControllerOptions =
    typeof pathOrOptions === "string" ? { path: pathOrOptions } : (pathOrOptions ?? {});
  return (target) => {
    CONTROLLER_META.set(target, opts);
    (target as unknown as { __isController?: boolean }).__isController = true;
    (target as unknown as { __controllerPath?: string }).__controllerPath = opts.path ?? "";
  };
}

// ─────────────────────────────────────────────────────────────────
// Route decorators — @get, @post, @put, @delete, @patch, @options, @head, @all
// Lowercase per convention.
// ─────────────────────────────────────────────────────────────────

export type RouteMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD" | "ALL";
export type RouteMeta = {
  method: RouteMethod;
  path: string;
  handlerName: string | symbol;
  guards?: GuardType[];
  interceptors?: InterceptorType[];
  pipes?: PipeTransform[];
};

const ROUTES_META = new WeakMap<object, RouteMeta[]>();

export function getRoutes(target: object): RouteMeta[] | undefined {
  return ROUTES_META.get(target);
}

function createRouteDecorator(method: RouteMethod, path: string): MethodDecorator {
  return (target, propertyKey) => {
    const ctor = (target as { constructor: object }).constructor;
    const existing = ROUTES_META.get(ctor) ?? [];
    // Check if route already exists for this handler to merge?
    existing.push({ method, path, handlerName: propertyKey });
    ROUTES_META.set(ctor, existing);
    // Also store on prototype for direct lookup
    const protoRoutes = (target as unknown as { __routes?: RouteMeta[] }).__routes ?? [];
    protoRoutes.push({ method, path, handlerName: propertyKey });
    (target as unknown as { __routes?: RouteMeta[] }).__routes = protoRoutes;
  };
}

export function get(path = "/"): MethodDecorator {
  return createRouteDecorator("GET", path);
}
export function post(path = "/"): MethodDecorator {
  return createRouteDecorator("POST", path);
}
export function put(path = "/"): MethodDecorator {
  return createRouteDecorator("PUT", path);
}
export function del(path = "/"): MethodDecorator {
  return createRouteDecorator("DELETE", path);
}
// `delete` is reserved, so alias
export const remove = del;
export function patch(path = "/"): MethodDecorator {
  return createRouteDecorator("PATCH", path);
}
export function options(path = "/"): MethodDecorator {
  return createRouteDecorator("OPTIONS", path);
}
export function head(path = "/"): MethodDecorator {
  return createRouteDecorator("HEAD", path);
}
export function all(path = "/"): MethodDecorator {
  return createRouteDecorator("ALL", path);
}

// Re-export with lowercase namespaced? Provide also uppercase aliases for compatibility
export {
  get as Get,
  post as Post,
  put as Put,
  patch as Patch,
  options as Options,
  head as Head,
  all as All,
};

// ─────────────────────────────────────────────────────────────────
// @useGuards, @useInterceptors, @usePipes — method & class decorators
// ─────────────────────────────────────────────────────────────────

const GUARDS_META = new WeakMap<object, GuardType[]>();
const INTERCEPTORS_META = new WeakMap<object, InterceptorType[]>();
const PIPES_META = new WeakMap<object, PipeTransform[]>();

export function useGuards(...guards: GuardType[]): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      // Method decorator
      const ctor = (target as { constructor: object }).constructor;
      const key = `${String(propertyKey)}:guards`;
      (ctor as unknown as Record<string, unknown>)[key] = guards;
      // Store per-handler
      const handlerGuards = new Map<string, GuardType[]>();
      // Use weak map per ctor+method
      const existing =
        (target as unknown as { __methodGuards?: Map<string, GuardType[]> }).__methodGuards ??
        new Map();
      existing.set(String(propertyKey), guards);
      (target as unknown as { __methodGuards?: Map<string, GuardType[]> }).__methodGuards =
        existing;
    } else {
      GUARDS_META.set(target, guards);
    }
  };
}

export function useInterceptors(
  ...interceptors: InterceptorType[]
): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      const existing =
        (target as unknown as { __methodInterceptors?: Map<string, InterceptorType[]> })
          .__methodInterceptors ?? new Map();
      existing.set(String(propertyKey), interceptors);
      (
        target as unknown as { __methodInterceptors?: Map<string, InterceptorType[]> }
      ).__methodInterceptors = existing;
    } else {
      INTERCEPTORS_META.set(target, interceptors);
    }
  };
}

export function usePipes(...pipes: PipeTransform[]): ClassDecorator & MethodDecorator {
  return (target: object, propertyKey?: string | symbol) => {
    if (propertyKey !== undefined) {
      const existing =
        (target as unknown as { __methodPipes?: Map<string, PipeTransform[]> }).__methodPipes ??
        new Map();
      existing.set(String(propertyKey), pipes);
      (target as unknown as { __methodPipes?: Map<string, PipeTransform[]> }).__methodPipes =
        existing;
    } else {
      PIPES_META.set(target, pipes);
    }
  };
}

export function getGuards(target: object): GuardType[] | undefined {
  return GUARDS_META.get(target);
}
export function getInterceptors(target: object): InterceptorType[] | undefined {
  return INTERCEPTORS_META.get(target);
}
export function getPipes(target: object): PipeTransform[] | undefined {
  return PIPES_META.get(target);
}
