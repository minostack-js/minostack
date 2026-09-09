/**
 * Route contract helpers — contract-first per §35.1.
 * Defines HTTP contracts that are schema-backed and can be projected to
 * OpenAPI / GraphQL / RPC client.
 */

export type AnySchema = {
  readonly "~standard"?: {
    readonly validate: (value: unknown) => { value: unknown } | { issues: readonly unknown[] };
  };
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: readonly unknown[] };
  };
} & object;

export type RouteContract<
  TInput = unknown,
  TOutput = unknown,
  TParams extends Record<string, string> = Record<string, string>,
> = {
  method: string;
  path: string;
  input?: AnySchema;
  output?: AnySchema;
  params?: AnySchema;
  operation?: {
    summary?: string;
    description?: string;
    tags?: string[];
    operationId?: string;
    deprecated?: boolean;
  };
};

// WeakMap to store contract metadata on handler functions
const CONTRACT_META = new WeakMap<object, RouteContract>();

export function setContract(handler: object, contract: RouteContract): void {
  CONTRACT_META.set(handler, contract);
}

export function getContract(handler: object): RouteContract | undefined {
  return CONTRACT_META.get(handler);
}

/**
 * Define a route contract — schema-backed, reusable.
 * Example:
 * ```ts
 * const CreateUserContract = defineRoute({
 *   method: "POST",
 *   path: "/users",
 *   input: CreateUserSchema,
 *   output: UserSchema,
 *   operation: { summary: "Create user", tags: ["Users"] }
 * })
 * app.post(CreateUserContract.path, validator("json", CreateUserContract.input), handler)
 * ```
 */
export function defineRoute<
  TInput,
  TOutput,
  TParams extends Record<string, string> = Record<string, string>,
>(contract: RouteContract<TInput, TOutput, TParams>): RouteContract<TInput, TOutput, TParams> {
  return contract;
}

/**
 * Attach operation metadata to a handler (for OpenAPI generation).
 * Usage:
 * ```ts
 * app.get("/users/:id", describeRoute({ summary: "Get user", tags: ["Users"] }, handler))
 * ```
 */
export function describeRoute(
  operation: NonNullable<RouteContract["operation"]>,
  handler: import("./types.js").Handler,
): import("./types.js").Handler {
  setContract(handler as object, { method: "", path: "", operation });
  return handler;
}

/**
 * Create a contract-aware handler that also carries input/output schemas.
 */
export function withContract(
  contract: RouteContract,
  handler: import("./types.js").Handler,
): import("./types.js").Handler {
  setContract(handler as object, contract);
  return handler;
}
