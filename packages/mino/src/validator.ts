/**
 * Schema-backed validation for Mino routes — contract-first.
 * Bridges @minostack/schema (if available) or any Standard Schema validator via `~standard`.
 */

import { Context, readLimitedText } from "./context.js";
import type { Handler } from "./types.js";
import { BadRequestError, PayloadTooLargeError, ValidationError } from "./errors.js";

// No hard dependency on @minostack/schema — accepts ANY Standard Schema (Zod, Valibot, ArkType, ...)
// plus MinoStack compat (`safeParse`) and legacy `parse`. Order is intentional and documented:
//   1. `~standard` — Standard Schema (preferred, spec-compliant, future-proof)
//   2. `safeParse` — MinoStack/Zod compat (supports existing tests)
//   3. `parse` — legacy throw-based (last resort)
// This keeps mino zero-dep: `npm i @minostack/mino` alone is complete; bring whichever validator you prefer.
type StandardSchema<TInput, TOutput> = {
  readonly "~standard": {
    readonly validate: (
      value: unknown,
    ) =>
      | { value: TOutput }
      | { issues: readonly { message: string; path?: readonly PropertyKey[] }[] };
  };
};

type AnySchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: { issues: readonly unknown[] };
  };
  parse?: (value: unknown) => unknown;
} & Partial<StandardSchema<unknown, unknown>>;

type Target = "json" | "query" | "param" | "header" | "form";

/**
 * Materialize request headers as an object, bounded by limits (A2).
 * Unbounded `Object.fromEntries(headers)` on attacker-controlled headers
 * is a memory-exhaustion vector; count and value-length are enforced here.
 */
function boundedHeaders(c: Context): Record<string, string> {
  const limits = c.limits;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of c.headers) {
    count++;
    if (count > limits.headerKeys) {
      throw new BadRequestError("Too many headers");
    }
    if (v.length > limits.headerValue) {
      throw new BadRequestError("Header value too long");
    }
    out[k] = v;
  }
  return out;
}

function getTargetValue(c: Context, target: Target): unknown {
  switch (target) {
    case "json": {
      // Note: json() is async; validator will handle async
      return undefined; // placeholder — handled via async extraction
    }
    case "query":
      return c.query;
    case "param":
      return c.params;
    case "header":
      return boundedHeaders(c);
    case "form":
      return undefined; // async
    default:
      return undefined;
  }
}

async function extractValue(c: Context, target: Target, limitOverride?: number): Promise<unknown> {
  switch (target) {
    case "json": {
      const ct = c.header("content-type") ?? "";
      const limit = limitOverride ?? c.limits.json;
      // Use clone so downstream c.req.json() / c.jsonBody() still works (body not consumed)
      // Also cache parsed JSON for jsonBody() reuse. Reads are byte-capped (A1).
      if (!ct.includes("application/json") && ct !== "") {
        // Still try to parse, but allow empty body
        try {
          if (c.req.body === null) return undefined;
          const text = await readLimitedText(c.req.clone(), limit);
          if (!text) return undefined;
          const json = JSON.parse(text) as unknown;
          // cache for downstream reuse
          c.setValidated("_rawJson", json);
          return json;
        } catch (e) {
          if (e instanceof PayloadTooLargeError) throw e;
          return undefined;
        }
      }
      try {
        if (c.req.body === null) return undefined;
        const text = await readLimitedText(c.req.clone(), limit);
        if (!text) return undefined;
        const json = JSON.parse(text) as unknown;
        c.setValidated("_rawJson", json);
        return json;
      } catch (e) {
        if (e instanceof BadRequestError) throw e;
        if (e instanceof PayloadTooLargeError) throw e;
        throw new BadRequestError("Invalid JSON body");
      }
    }
    case "form": {
      const limit = limitOverride ?? c.limits.form;
      try {
        const cl = c.header("content-length");
        if (cl !== null) {
          const n = Number(cl);
          if (Number.isFinite(n) && n > limit) {
            throw new PayloadTooLargeError(`Body exceeds limit of ${limit} bytes`);
          }
        }
        const fd = await c.req.clone().formData();
        const out: Record<string, unknown> = {};
        let count = 0;
        fd.forEach((v, k) => {
          count++;
          if (count > c.limits.fieldCount) {
            throw new PayloadTooLargeError(`Form exceeds limit of ${c.limits.fieldCount} fields`);
          }
          out[k] = v;
        });
        return out;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return undefined;
      }
    }
    case "query":
      return c.query;
    case "param":
      return c.params;
    case "header":
      return boundedHeaders(c);
    default:
      return undefined;
  }
}

const MAX_ISSUES = 50;
/** Max chars per string inside a validation issue (A4) — bounds error bodies. */
const MAX_ISSUE_CHARS = 500;

/**
 * Truncate strings inside validation issues (recursively, depth-capped) so
 * third-party schemas echoing `received: <entire body>` can't blow up or leak
 * unbounded data into 422 responses and logs.
 */
function truncateIssueValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") {
    return v.length > MAX_ISSUE_CHARS ? v.slice(0, MAX_ISSUE_CHARS) : v;
  }
  if (depth >= 3 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((item) => truncateIssueValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = truncateIssueValue(val, depth + 1);
  }
  return out;
}

function truncateIssues(issues: readonly unknown[]): readonly unknown[] {
  return issues.map((issue) => truncateIssueValue(issue));
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function"
  );
}

async function validateWithSchema(
  schema: AnySchema,
  value: unknown,
): Promise<{ success: true; data: unknown } | { success: false; issues: readonly unknown[] }> {
  // Priority: ~standard (spec) → safeParse (MinoStack/Zod compat) → parse (legacy)
  // ~standard is checked first to ensure spec compliance; safeParse second for backwards compat.
  const std = (schema as StandardSchema<unknown, unknown>)["~standard"];
  if (std) {
    const raw = std.validate(value);
    // Standard Schema permits async validate; Mino v0.1 is sync-only by design
    // (blueprint §28 defers async validation). Fail closed with 500, not a
    // misclassified 422 or a Promise leaking into validated data.
    if (isThenable(raw)) {
      throw new Error("Async Standard Schema not supported: use a sync validator");
    }
    const res = raw as { value: unknown } | { issues: readonly unknown[] };
    if ("value" in res) return { success: true, data: res.value };
    const issues = [...(res.issues ?? [])];
    return { success: false, issues: truncateIssues(issues.slice(0, MAX_ISSUES)) };
  }
  if (typeof schema.safeParse === "function") {
    const res = schema.safeParse(value);
    if (isThenable(res)) {
      throw new Error("Async Standard Schema not supported: use a sync validator");
    }
    const sync = res as {
      success: boolean;
      data?: unknown;
      error?: { issues: readonly unknown[] };
    };
    if (sync.success) return { success: true, data: sync.data };
    const issues = [...(sync.error?.issues ?? [{ message: "Validation failed" }])];
    return { success: false, issues: truncateIssues(issues.slice(0, MAX_ISSUES)) };
  }
  // Fallback: try parse
  if (typeof schema.parse === "function") {
    try {
      const data = schema.parse(value);
      if (isThenable(data)) {
        throw new Error("Async Standard Schema not supported: use a sync validator");
      }
      return { success: true, data };
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("Async Standard Schema not supported")) throw e;
      const issues = [
        ...(((e as { issues?: readonly unknown[] })?.issues ?? [
          { message: (e as Error)?.message ?? "Validation failed" },
        ]) as readonly unknown[]),
      ];
      return { success: false, issues: truncateIssues(issues.slice(0, MAX_ISSUES)) };
    }
  }
  throw new Error("Invalid schema: missing safeParse/parse/~standard");
}

/**
 * Create a validator middleware for a given target and schema.
 *
 * ```ts
 * app.post("/users", validator("json", CreateUserSchema), (c) => {
 *   const data = c.valid("json") // typed?
 *   return c.json({ ok: true })
 * })
 * ```
 *
 * Per-route body limit override (bytes) for `json`/`form` targets:
 *
 * ```ts
 * app.post("/upload", validator("json", BigSchema, { limit: 1024 * 1024 }), handler)
 * ```
 */
export function validator(target: Target, schema: AnySchema, opts?: { limit?: number }): Handler {
  return async (c, next) => {
    const raw =
      target === "query" || target === "param" || target === "header"
        ? getTargetValue(c as unknown as Context, target)
        : await extractValue(c as unknown as Context, target, opts?.limit);

    const result = await validateWithSchema(schema, raw);
    if (!result.success) {
      // Throw ValidationError so errorHandler can format; but also allow custom handling.
      // Issues already capped at MAX_ISSUES (A5) so error bodies stay bounded.
      throw new ValidationError("Validation failed", result.issues);
    }
    (c as unknown as Context).setValidated(target, result.data);
    // Cache parsed json for downstream if needed (avoid re-parsing)
    if (target === "json") {
      // Store also as "json" validated
    }
    await next();
  };
}

/**
 * DTO helper — defines a contract backed by schema.
 * Kept minimal per §8: DTO is primarily a schema-owned contract identifier.
 */
export function dto(schema: AnySchema): AnySchema {
  return schema;
}
