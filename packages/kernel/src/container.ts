/**
 * Container — deterministic DI with explicit errors, circular detection, scopes.
 * Design goals per §22:
 * - predictable resolution
 * - useful errors
 * - circular detection
 * - testability / overrides
 * - request-scoped support
 */

import { getTokenName, isClassToken, type Token } from "./token.js";
import { normalizeProvider, type NormalizedProvider, type Provider } from "./provider.js";
import type { Scope } from "./scope.js";

// Types for metadata storage
export type ClassType<T = unknown> = new (...args: any[]) => T;

export class Container {
  /** Token -> normalized provider */
  private providers = new Map<Token, NormalizedProvider>();
  /** Singleton cache */
  private singletons = new Map<Token, unknown>();
  /** Request-scoped cache is per Container instance; request containers are children */
  private requestCache = new Map<Token, unknown>();

  /** Parent for hierarchical lookup (module graph) */
  parent?: Container;

  /** Children for request scoping */
  private children = new Set<Container>();

  /** Track instantiation stack for circular detection */
  private resolving = new Set<Token>();

  constructor(parent?: Container) {
    this.parent = parent;
    if (parent) parent.children.add(this);
  }

  register(provider: Provider | ClassType): this {
    const normalized = normalizeProvider(provider as Provider);
    if (this.providers.has(normalized.token)) {
      // Allow override only via explicit `override`? For v0.1, last wins with warning? We'll throw for determinism.
      throw new Error(
        `Provider token "${getTokenName(normalized.token)}" already registered. Duplicate provider.`,
      );
    }
    this.providers.set(normalized.token, normalized);
    return this;
  }

  has(token: Token): boolean {
    if (this.providers.has(token)) return true;
    if (this.parent?.has(token)) return true;
    return false;
  }

  /**
   * Resolve a token. Handles scopes:
   * - singleton: cached in root container
   * - request: cached per request container (this)
   * - transient: always new
   */
  async get<T>(token: Token<T>): Promise<T> {
    return this.resolve(token, new Set());
  }

  /** Sync version — throws if provider is async factory */
  getSync<T>(token: Token<T>): T {
    // For sync path, we need to avoid async. We'll implement via resolveSync
    return this.resolveSync(token, new Set());
  }

  /** Create a child request-scoped container */
  createRequestScope(): Container {
    const child = new Container(this);
    // Share providers map by reference? Or copy? For v0.1, child inherits parent providers via `parent` lookup,
    // but request-scoped providers registered in parent will be cached in child.
    // To avoid copying large map, child will delegate to parent for provider lookup.
    return child;
  }

  /** For testing: override a token with value */
  override<T>(token: Token<T>, value: T): this {
    // Remove existing if any
    this.providers.delete(token);
    this.providers.set(token, { kind: "value", token, useValue: value, scope: "singleton" });
    this.singletons.set(token, value);
    return this;
  }

  /** Clear caches (for tests) */
  clearCache(): void {
    this.singletons.clear();
    this.requestCache.clear();
    for (const child of this.children) child.clearCache();
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal resolution
  // ─────────────────────────────────────────────────────────────────

  private async resolve<T>(token: Token<T>, seen: Set<Token>): Promise<T> {
    if (seen.has(token)) {
      const chain = [...seen, token].map(getTokenName).join(" -> ");
      throw new Error(`Circular dependency detected: ${chain}`);
    }
    seen.add(token);

    const provider = this.findProvider(token);
    if (!provider) {
      throw new Error(
        `No provider for token "${getTokenName(token)}". Did you forget to register it or export it from a module?`,
      );
    }

    // Handle existing alias
    if (provider.kind === "existing") {
      const res = await this.resolve(provider.useExisting as Token<T>, seen);
      seen.delete(token);
      return res;
    }

    // Scope handling
    if (provider.scope === "singleton") {
      // Singletons are stored in root
      const root = this.getRoot();
      if (root.singletons.has(token)) {
        seen.delete(token);
        return root.singletons.get(token) as T;
      }
      const instance = await this.instantiate(provider, seen);
      root.singletons.set(token, instance);
      seen.delete(token);
      // Invoke lifecycle if applicable (onInit) — deferred to Application, but we can call here for standalone?
      // We'll not call lifecycle here; Container is low-level.
      return instance as T;
    }

    if (provider.scope === "request") {
      if (this.requestCache.has(token)) {
        seen.delete(token);
        return this.requestCache.get(token) as T;
      }
      const instance = await this.instantiate(provider, seen);
      this.requestCache.set(token, instance);
      seen.delete(token);
      return instance as T;
    }

    if (provider.scope === "transient") {
      const instance = await this.instantiate(provider, seen);
      seen.delete(token);
      return instance as T;
    }

    seen.delete(token);
    throw new Error(
      `Unknown scope "${(provider as { scope: Scope }).scope}" for token ${getTokenName(token)}`,
    );
  }

  private resolveSync<T>(token: Token<T>, seen: Set<Token>): T {
    if (seen.has(token)) {
      const chain = [...seen, token].map(getTokenName).join(" -> ");
      throw new Error(`Circular dependency detected: ${chain}`);
    }
    seen.add(token);
    const provider = this.findProvider(token);
    if (!provider) throw new Error(`No provider for token "${getTokenName(token)}"`);
    if (provider.kind === "existing") {
      const res = this.resolveSync(provider.useExisting as Token<T>, seen);
      seen.delete(token);
      return res;
    }
    if (provider.scope === "singleton") {
      const root = this.getRoot();
      if (root.singletons.has(token)) {
        seen.delete(token);
        return root.singletons.get(token) as T;
      }
      const instance = this.instantiateSync(provider, seen);
      root.singletons.set(token, instance);
      seen.delete(token);
      return instance as T;
    }
    if (provider.scope === "request") {
      if (this.requestCache.has(token)) {
        seen.delete(token);
        return this.requestCache.get(token) as T;
      }
      const instance = this.instantiateSync(provider, seen);
      this.requestCache.set(token, instance);
      seen.delete(token);
      return instance as T;
    }
    if (provider.scope === "transient") {
      const instance = this.instantiateSync(provider, seen);
      seen.delete(token);
      return instance as T;
    }
    seen.delete(token);
    throw new Error(`Unknown scope`);
  }

  private findProvider<T>(token: Token<T>): NormalizedProvider<T> | undefined {
    const local = this.providers.get(token) as NormalizedProvider<T> | undefined;
    if (local) return local;
    if (this.parent) return this.parent.findProvider(token);
    return undefined;
  }

  private getRoot(): Container {
    let cur: Container = this;
    while (cur.parent) cur = cur.parent;
    return cur;
  }

  private async instantiate<T>(provider: NormalizedProvider<T>, seen: Set<Token>): Promise<T> {
    switch (provider.kind) {
      case "value":
        return provider.useValue as T;
      case "factory": {
        const deps = await this.resolveDeps(provider.inject ?? [], seen);
        const result = await provider.useFactory(...deps);
        return result as T;
      }
      case "class": {
        const deps = await this.resolveDeps(
          await this.getClassDeps(provider.useClass, provider.inject),
          seen,
        );
        const instance = new provider.useClass(...deps);
        return instance as T;
      }
      default:
        throw new Error(`Unknown provider kind ${(provider as { kind: string }).kind}`);
    }
  }

  private instantiateSync<T>(provider: NormalizedProvider<T>, seen: Set<Token>): T {
    switch (provider.kind) {
      case "value":
        return provider.useValue as T;
      case "factory": {
        const deps = this.resolveDepsSync(provider.inject ?? [], seen);
        const result = provider.useFactory(...deps);
        if (result instanceof Promise)
          throw new Error(
            `Async factory requires async get() for token ${getTokenName(provider.token)}`,
          );
        return result as T;
      }
      case "class": {
        const deps = this.resolveDepsSync(
          this.getClassDepsSync(provider.useClass, provider.inject),
          seen,
        );
        const instance = new provider.useClass(...deps);
        return instance as T;
      }
      default:
        throw new Error(`Unknown provider kind`);
    }
  }

  private async resolveDeps(tokens: Token[], seen: Set<Token>): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const t of tokens) out.push(await this.resolve(t, new Set(seen)));
    return out;
  }

  private resolveDepsSync(tokens: Token[], seen: Set<Token>): unknown[] {
    const out: unknown[] = [];
    for (const t of tokens) out.push(this.resolveSync(t, new Set(seen)));
    return out;
  }

  /** Get constructor deps via explicit inject, @inject metadata, or reflect design:paramtypes */
  private async getClassDeps(ctor: ClassType, explicit?: Token[]): Promise<Token[]> {
    if (explicit && explicit.length > 0) return explicit;
    const metaInject = (ctor as unknown as { inject?: Token[] }).inject;
    if (metaInject) return metaInject;
    const injectMeta = getInjectTokens(ctor);
    if (injectMeta && injectMeta.length > 0) return injectMeta;
    const paramTypes = getParamTypes(ctor);
    if (paramTypes && paramTypes.length > 0) {
      // Filter out primitives that are not DI tokens (Object, String, Number, Boolean, Array, etc.)
      const filtered = (paramTypes as unknown[]).filter(
        (t) => t !== Object && t !== String && t !== Number && t !== Boolean && t !== Array,
      );
      return filtered as unknown as Token[];
    }
    return [];
  }

  private getClassDepsSync(ctor: ClassType, explicit?: Token[]): Token[] {
    if (explicit && explicit.length > 0) return explicit;
    const metaInject = (ctor as unknown as { inject?: Token[] }).inject;
    if (metaInject) return metaInject;
    const injectMeta = getInjectTokens(ctor);
    if (injectMeta && injectMeta.length > 0) return injectMeta;
    const paramTypes = getParamTypes(ctor);
    if (paramTypes && paramTypes.length > 0) {
      const filtered = (paramTypes as unknown[]).filter(
        (t) => t !== Object && t !== String && t !== Number && t !== Boolean && t !== Array,
      );
      return filtered as unknown as Token[];
    }
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// Metadata helpers for @inject
// ─────────────────────────────────────────────────────────────────

const INJECT_TOKENS = new WeakMap<object, Token[]>();
const PARAMTYPES_KEY = "design:paramtypes";

export function setInjectTokens(target: object, tokens: Token[]): void {
  INJECT_TOKENS.set(target, tokens);
}

export function getInjectTokens(target: object): Token[] | undefined {
  return INJECT_TOKENS.get(target);
}

export function getParamTypes(target: object): unknown[] | undefined {
  // Try Reflect.getMetadata if available
  const reflect = (
    globalThis as unknown as {
      Reflect?: { getMetadata?: (key: string, target: object) => unknown };
    }
  ).Reflect;
  if (reflect?.getMetadata) {
    try {
      const types = reflect.getMetadata(PARAMTYPES_KEY, target) as unknown[] | undefined;
      return types;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
