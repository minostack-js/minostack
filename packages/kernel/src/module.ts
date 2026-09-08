/**
 * Module system — strong application boundaries, deterministic graph.
 * Lowecase decorator `@module` per user preference.
 */

import type { Provider } from "./provider.js";
import type { Token } from "./token.js";

export type ModuleMetadata = {
  imports?: ModuleClass[];
  providers?: (Provider | (new (...args: any[]) => unknown))[];
  controllers?: (new (...args: any[]) => unknown)[];
  exports?: Token[];
};

export type ModuleClass = new (...args: any[]) => unknown;

const MODULE_META = new WeakMap<object, ModuleMetadata>();

export function getModuleMetadata(target: object): ModuleMetadata | undefined {
  return MODULE_META.get(target);
}

export function setModuleMetadata(target: object, meta: ModuleMetadata): void {
  MODULE_META.set(target, meta);
}

/**
 * `@module` decorator — lowercase, modern-TS friendly.
 * Usage:
 * ```ts
 * @module({
 *   imports: [UsersModule],
 *   providers: [UserService],
 *   controllers: [UserController],
 *   exports: [UserService]
 * })
 * class AppModule {}
 * ```
 */
export function module(metadata: ModuleMetadata): ClassDecorator {
  return (target) => {
    setModuleMetadata(target, metadata);
    // Also store on prototype for instance lookup if needed
    (target as unknown as { __moduleMeta?: ModuleMetadata }).__moduleMeta = metadata;
  };
}

// Alias for compatibility if someone uses `Module` capitalization (not preferred but support)
export const Module = module;

/**
 * Functional helper — define a module without decorator (alternative style).
 */
export function defineModule(metadata: ModuleMetadata): ModuleClass {
  class DefinedModule {}
  setModuleMetadata(DefinedModule, metadata);
  return DefinedModule as ModuleClass;
}
