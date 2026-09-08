/**
 * Provider definitions — explicit, no hidden magic.
 */

import type { Token } from "./token.js";
import type { Scope } from "./scope.js";

export type Provider<T = unknown> =
  ClassProvider<T> | ValueProvider<T> | FactoryProvider<T> | ExistingProvider<T>;

export interface BaseProvider<T = unknown> {
  /** Token this provider fulfills */
  token: Token<T>;
  /** Scope — default singleton */
  scope?: Scope;
}

export interface ClassProvider<T = unknown> extends BaseProvider<T> {
  useClass: new (...args: any[]) => T;
  /** Optional explicit injection tokens for constructor params (overrides auto-inferred) */
  inject?: Token[];
}

export interface ValueProvider<T = unknown> extends BaseProvider<T> {
  useValue: T;
}

export interface FactoryProvider<T = unknown> extends BaseProvider<T> {
  useFactory: (...args: unknown[]) => T | Promise<T>;
  inject?: Token[];
}

export interface ExistingProvider<T = unknown> extends BaseProvider<T> {
  useExisting: Token<T>;
}

/** Normalized internal provider */
export type NormalizedProvider<T = unknown> =
  | {
      kind: "class";
      token: Token<T>;
      useClass: new (...args: any[]) => T;
      scope: Scope;
      inject?: Token[];
    }
  | { kind: "value"; token: Token<T>; useValue: T; scope: Scope }
  | {
      kind: "factory";
      token: Token<T>;
      useFactory: (...args: unknown[]) => T | Promise<T>;
      scope: Scope;
      inject?: Token[];
    }
  | { kind: "existing"; token: Token<T>; useExisting: Token<T>; scope: Scope };

export function normalizeProvider<T>(
  p: Provider<T> | (new (...args: any[]) => T),
): NormalizedProvider<T> {
  // Shorthand: bare class => { token: class, useClass: class }
  if (typeof p === "function") {
    return {
      kind: "class",
      token: p as Token<T>,
      useClass: p as new (...args: any[]) => T,
      scope: "singleton",
    };
  }
  const base = p as Provider<T>;
  const scope = (base as { scope?: Scope }).scope ?? "singleton";
  if ("useClass" in base) {
    return {
      kind: "class",
      token: base.token,
      useClass: (base as ClassProvider<T>).useClass,
      scope,
      inject: (base as ClassProvider<T>).inject,
    };
  }
  if ("useValue" in base) {
    return {
      kind: "value",
      token: base.token,
      useValue: (base as ValueProvider<T>).useValue,
      scope,
    };
  }
  if ("useFactory" in base) {
    return {
      kind: "factory",
      token: base.token,
      useFactory: (base as FactoryProvider<T>).useFactory,
      scope,
      inject: (base as FactoryProvider<T>).inject,
    };
  }
  if ("useExisting" in base) {
    return {
      kind: "existing",
      token: base.token,
      useExisting: (base as ExistingProvider<T>).useExisting,
      scope,
    };
  }
  throw new Error(`Invalid provider: ${JSON.stringify(p)}`);
}
