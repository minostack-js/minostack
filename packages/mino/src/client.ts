/**
 * Type-safe client proxy — minimal RPC-like invocation over HTTP contracts.
 * Consumes route definitions from Mino app graph or manual contract.
 * Phase 5: Route contract extraction + typed request builders.
 *
 * Usage (server):
 *   const app = new Mino().get("/users/:id", ...).post("/users", ...)
 *
 * Usage (client):
 *   const client = createClient<typeof app>("http://localhost:3000")
 *   await client.users[":id"].$get({ param: { id: "1" } })
 *
 * For v0.1, we implement a simpler API: `hc(appUrl, app?)`
 * and a generic fetch wrapper `createClient`.
 */

export type ClientOptions = {
  fetch?: typeof fetch;
  headers?: HeadersInit;
};

// Generic typed client — we use Proxy to build path dynamically.
// For simplicity, the type is `any` at runtime; compile-time types would be derived from app via `infer`.
export type MinoClient = {
  // Index signature for path segments
  [key: string]: MinoClient & {
    $get: (opts?: RequestOptions) => Promise<Response>;
    $post: (opts?: RequestOptions) => Promise<Response>;
    $put: (opts?: RequestOptions) => Promise<Response>;
    $delete: (opts?: RequestOptions) => Promise<Response>;
    $patch: (opts?: RequestOptions) => Promise<Response>;
    $fetch: (opts?: RequestOptions & { method?: string }) => Promise<Response>;
  };
};

export type RequestOptions = {
  param?: Record<string, string>;
  query?: Record<string, string | string[]>;
  header?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  fetch?: RequestInit;
};

function serializeQuery(query?: Record<string, string | string[]>): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, item);
    } else if (v !== undefined) {
      sp.set(k, v);
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function buildUrl(baseUrl: string, pathParts: string[], opts?: RequestOptions): string {
  let path = "/" + pathParts.join("/");
  // Replace :param placeholders — replace all occurrences (duplicate param names)
  if (opts?.param) {
    for (const [k, v] of Object.entries(opts.param)) {
      const encoded = encodeURIComponent(v);
      // Use split-join to avoid regex escaping issues and replace all occurrences
      path = path.split(`:${k}`).join(encoded);
    }
  }
  // Also support bracket style? Not needed.
  const q = serializeQuery(opts?.query);
  // Normalize slashes
  const base = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.replace(/\/+/g, "/");
  return `${base}${normalizedPath}${q}`;
}

/**
 * Create a type-safe client proxy.
 * @param baseUrl — e.g. "http://localhost:3000"
 * @param options — fetch override, headers
 */
export function createClient(baseUrl: string, options: ClientOptions = {}): MinoClient {
  const fetcher = options.fetch ?? fetch;

  const createProxy = (pathParts: string[]): MinoClient => {
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        // Avoid thenable trap: `await client` or `Promise.resolve(client)` must not hang
        if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
        if (typeof prop === "symbol") return undefined;
        if (
          prop === "$get" ||
          prop === "$post" ||
          prop === "$put" ||
          prop === "$delete" ||
          prop === "$patch" ||
          prop === "$fetch"
        ) {
          const methodMap: Record<string, string> = {
            $get: "GET",
            $post: "POST",
            $put: "PUT",
            $delete: "DELETE",
            $patch: "PATCH",
            $fetch: "GET",
          };
          return async (opts: RequestOptions & { method?: string } = {}) => {
            const method = prop === "$fetch" ? (opts.method ?? "GET") : (methodMap[prop] as string);
            const url = buildUrl(baseUrl, pathParts, opts);
            const headers = new Headers(options.headers);
            if (opts.header) {
              for (const [k, v] of Object.entries(opts.header)) headers.set(k, v);
            }
            let body: BodyInit | undefined;
            if (opts.json !== undefined) {
              headers.set("content-type", "application/json");
              body = JSON.stringify(opts.json);
            } else if (opts.form) {
              body = new URLSearchParams(opts.form).toString();
              headers.set("content-type", "application/x-www-form-urlencoded");
            }
            const init: RequestInit = {
              method,
              headers,
              body: method === "GET" || method === "HEAD" ? undefined : body,
              ...opts.fetch,
            };
            return fetcher(url, init);
          };
        }
        // For path segment, create new proxy with appended part
        // Avoid proxying built-ins
        if (typeof prop === "string" && !prop.startsWith("$") && !prop.startsWith("_")) {
          return createProxy([...pathParts, prop]);
        }
        return undefined;
      },
    };
    return new Proxy({} as Record<string, unknown>, handler) as unknown as MinoClient;
  };

  return createProxy([]);
}

/**
 * Shorthand alias `hc` (Hono client style) for familiarity.
 */
export const hc = createClient;

/**
 * Infer client type from Mino instance — placeholder for future strong inference.
 * Currently returns generic MinoClient; future version could extract route types via `ClientFor<App>`.
 */
export type InferClient<App> = App extends { getRoutes: () => readonly unknown[] }
  ? MinoClient
  : MinoClient;

// ─────────────────────────────────────────────────────────────────
// Contract client (plan P4.2) — server contracts drive the client, so
// operation ids, paths, and schemas are never duplicated.
// ─────────────────────────────────────────────────────────────────

import type { RouteContract } from "./contract.js";
import { ValidationError } from "./errors.js";

export interface ContractCallOptions {
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  header?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  fetch?: RequestInit;
}

export interface ContractClientOptions extends ClientOptions {
  /** Validate `json` against `contract.input` before sending (default false). */
  validateInput?: boolean;
}

export type ContractClient = Record<string, (args?: ContractCallOptions) => Promise<Response>>;

function validateContractInput(contract: RouteContract, json: unknown): void {
  const schema = contract.input;
  if (schema === undefined || json === undefined) return;
  const std = schema["~standard"];
  if (std) {
    const res = std.validate(json) as { value: unknown } | { issues: readonly unknown[] };
    if ("issues" in res)
      throw new ValidationError("Contract input invalid", [...(res.issues ?? [])]);
    return;
  }
  if (typeof schema.safeParse === "function") {
    const res = schema.safeParse(json) as {
      success: boolean;
      error?: { issues: readonly unknown[] };
    };
    if (!res.success) {
      throw new ValidationError("Contract input invalid", [...(res.error?.issues ?? [])]);
    }
  }
}

/**
 * Build a client from route contracts. Operations are keyed by
 * `contract.operation.operationId` (required — throws otherwise).
 *
 * ```ts
 * const CreateUser = defineRoute({
 *   method: "POST", path: "/v1/users", input: CreateUserSchema,
 *   operation: { operationId: "createUser" },
 * });
 * const client = contractClient("https://api.example.com", [CreateUser]);
 * await client.createUser({ json: { name: "Ada" } });
 * ```
 */
export function contractClient(
  baseUrl: string,
  contracts: readonly RouteContract[],
  options: ContractClientOptions = {},
): ContractClient {
  const fetcher = options.fetch ?? fetch;
  const out: ContractClient = {};
  for (const contract of contracts) {
    const id = contract.operation?.operationId;
    if (!id) throw new Error("contractClient: every contract needs operation.operationId");
    out[id] = async (args: ContractCallOptions = {}): Promise<Response> => {
      if (options.validateInput) validateContractInput(contract, args.json);
      const url = buildUrl(
        baseUrl,
        contract.path.split("/").filter((s) => s.length > 0),
        {
          param: args.params,
          query: args.query,
        },
      );
      const headers = new Headers(options.headers);
      if (args.header) {
        for (const [k, v] of Object.entries(args.header)) headers.set(k, v);
      }
      let body: BodyInit | undefined;
      if (args.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(args.json);
      } else if (args.form) {
        body = new URLSearchParams(args.form).toString();
        headers.set("content-type", "application/x-www-form-urlencoded");
      }
      const method = contract.method.toUpperCase();
      const init: RequestInit = {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        ...args.fetch,
      };
      return fetcher(url, init);
    };
  }
  return out;
}
