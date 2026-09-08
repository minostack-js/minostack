/**
 * Type-level route utilities for @minostack/mino.
 * Shallow, composable types — avoid deep recursion per AGENTS §29.
 */

// Extract param names from a path like "/users/:id/books/:bookId"
export type ExtractParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

// Map param names to string values — supports optional :id? as id?: string
type RequiredParamsFor<Path extends string> = {
  [K in ExtractParamNames<Path> as K extends `${string}?` ? never : K]: string;
};
type OptionalParamsFor<Path extends string> = {
  [K in ExtractParamNames<Path> as K extends `${infer Name}?` ? Name : never]?: string;
};
export type ParamsFor<Path extends string> = RequiredParamsFor<Path> & OptionalParamsFor<Path>;

// For "*" wildcard, we capture remainder as "wildcard" or "*"
export type HasWildcard<Path extends string> = Path extends `${string}*` ? true : false;

export type ContextParams<Path extends string> =
  HasWildcard<Path> extends true ? ParamsFor<Path> & { wildcard: string } : ParamsFor<Path>;

// Generic handler env type
export type Env = Record<string, unknown>;

// Next function for middleware
export type Next = () => Promise<void>;

// Handler signature — receives Context, returns Response
export type Handler<E = Env, P = Record<string, string>> = (
  c: import("./context.js").Context<E, P>,
  next: Next,
) => Response | void | Promise<Response | void>;

// Middleware is same as Handler (unified)
export type MiddlewareHandler<E = Env, P = Record<string, string>> = Handler<E, P>;

// Route definition for introspection (used by OpenAPI, RPC, etc.)
export interface RouteDefinition {
  readonly method: string;
  readonly path: string;
  readonly handlers: readonly Handler[];
}

// Error handler signature
export type ErrorHandler<E = Env> = (
  err: unknown,
  c: import("./context.js").Context<E, Record<string, string>>,
) => Response | Promise<Response>;

// Not-found handler
export type NotFoundHandler<E = Env> = (
  c: import("./context.js").Context<E, Record<string, string>>,
) => Response | Promise<Response>;
