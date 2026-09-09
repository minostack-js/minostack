/**
 * @minostack/config — schema-backed, redacted-by-default configuration.
 *
 * Dev-mode preview. `src/` stays runtime-portable, so environment access is
 * injected: pass `process.env` (or a test double) into `fromEnv`.
 *
 * ```ts
 * import { m } from "@minostack/schema";
 * import { defineConfig, loadConfig, fromEnv } from "@minostack/config";
 *
 * const ServerConfig = defineConfig(m.object({ port: m.number().int() }));
 * const cfg = loadConfig(ServerConfig, [fromEnv("APP_", process.env)]);
 * ```
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
  parse?: (value: unknown) => unknown;
} & object;

export class ConfigError extends Error {
  readonly issues: readonly unknown[];
  constructor(message: string, issues: readonly unknown[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface ConfigDefinition<T = unknown> {
  readonly name: string;
  readonly schema: AnySchema;
  readonly secrets?: readonly string[];
  readonly _type?: T;
}

export type InferConfig<D> = D extends ConfigDefinition<infer T> ? T : never;

/** Declare a named, schema-backed config shape. */
export function defineConfig<T>(
  schema: AnySchema,
  opts: { name?: string; secrets?: readonly string[] } = {},
): ConfigDefinition<T> {
  return { name: opts.name ?? "config", schema, secrets: opts.secrets ?? [] };
}

function validateSchema(
  schema: AnySchema,
  value: unknown,
): { success: true; data: unknown } | { success: false; issues: readonly unknown[] } {
  const std = schema["~standard"];
  if (std) {
    const res = std.validate(value) as { value: unknown } | { issues: readonly unknown[] };
    if ("value" in res) return { success: true, data: res.value };
    return { success: false, issues: [...(res.issues ?? [])] };
  }
  if (typeof schema.safeParse === "function") {
    const res = schema.safeParse(value);
    if (res.success) return { success: true, data: res.data };
    return { success: false, issues: [...(res.error?.issues ?? [])] };
  }
  if (typeof schema.parse === "function") {
    try {
      return { success: true, data: schema.parse(value) };
    } catch (e: unknown) {
      const issues = ((e as { issues?: readonly unknown[] })?.issues ?? [
        { message: e instanceof Error ? e.message : "Validation failed" },
      ]) as readonly unknown[];
      return { success: false, issues: [...issues] };
    }
  }
  throw new ConfigError("Invalid schema: missing ~standard/safeParse/parse");
}

/** A partial raw layer merged (later layers win) before validation. */
export type ConfigSource = Record<string, unknown>;

/** Raw object layer. */
export function fromObject(obj: Record<string, unknown>): ConfigSource {
  return { ...obj };
}

const SECRET_KEY = /(secret|token|password|passwd|api[-_]?key|private[-_]?key)/i;

/**
 * Environment layer. `APP_PORT` with prefix `"APP_"` maps to `port`
 * (lowercased first letter). Values stay strings — the schema decides how to
 * interpret them. `env` is injected so `src/` never touches `process`.
 */
export function fromEnv(prefix: string, env: Record<string, string | undefined>): ConfigSource {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    if (!rest) continue;
    const key =
      rest.charAt(0).toLowerCase() +
      rest
        .slice(1)
        .toLowerCase()
        .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = v;
  }
  return out;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
}

/** Merge layers (later wins) and validate. Fails fast with actionable errors. */
export function loadConfig<T>(def: ConfigDefinition<T>, sources: ConfigSource[] = []): T {
  const merged: Record<string, unknown> = {};
  for (const src of sources) Object.assign(merged, src);
  const res = validateSchema(def.schema, merged);
  if (!res.success) {
    throw new ConfigError(formatConfigError(def, res.issues), res.issues);
  }
  deepFreeze(res.data);
  return res.data as T;
}

/** Actionable message: names the config, counts issues, never echoes secrets. */
export function formatConfigError(def: ConfigDefinition, issues: readonly unknown[]): string {
  const lines = issues.slice(0, 10).map((i) => {
    const issue = i as { path?: readonly unknown[]; message?: unknown };
    const at = Array.isArray(issue.path) ? issue.path.join(".") : "";
    const msg = typeof issue.message === "string" ? issue.message : "invalid value";
    return at ? `  - ${at}: ${msg}` : `  - ${msg}`;
  });
  return `Invalid config "${def.name}" (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}

/**
 * Redacted copy for logs/health output. Keys declared in `secrets` plus
 * anything matching secret-like names are masked; long strings truncate.
 */
export function redactConfig<T>(def: ConfigDefinition<T>, resolved: T): Record<string, unknown> {
  const extra = new Set((def.secrets ?? []).map((s) => s.toLowerCase()));
  const walk = (value: unknown, key = ""): unknown => {
    if (extra.has(key.toLowerCase()) || SECRET_KEY.test(key)) return "***";
    if (typeof value === "string") {
      return value.length > 200 ? `${value.slice(0, 200)}…(truncated)` : value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k);
      return out;
    }
    return value;
  };
  return walk(resolved) as Record<string, unknown>;
}
