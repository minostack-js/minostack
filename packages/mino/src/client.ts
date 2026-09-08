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
