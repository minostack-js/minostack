/**
 * `@minostack/mino/envelope` — optional enterprise response conventions.
 *
 * Zero dependencies, runtime-agnostic. Plain helpers, not mandatory behavior:
 * existing handlers keep working unchanged.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { ok, fail, page } from "@minostack/mino/envelope";
 *
 * const app = new Mino();
 * app.get("/users", (c) => c.json(ok([{ id: "1" }])));
 * app.get("/paged", (c) => c.json(page(items, { page: 1, perPage: 20, total: 95 })));
 * ```
 */

export interface EnvelopeMeta {
  /** Machine-readable code (e.g. "ok", "validation_failed") */
  code?: string;
  /** Echoed request id / trace id for correlation */
  requestId?: string;
  traceId?: string;
  /** Deprecation metadata for versioned APIs */
  deprecated?: boolean;
  sunset?: string;
  [key: string]: unknown;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta?: EnvelopeMeta;
}

export interface ErrorEnvelope {
  ok: false;
  error: string;
  status: number;
  code?: string;
  meta?: EnvelopeMeta;
}

export interface OffsetPage<T> {
  ok: true;
  data: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  meta?: EnvelopeMeta;
}

export interface CursorPage<T> {
  ok: true;
  data: T[];
  nextCursor: string | null;
  meta?: EnvelopeMeta;
}

/** Build a success envelope object (pair with `c.json(ok(...))`). */
export function ok<T>(data: T, meta?: EnvelopeMeta): SuccessEnvelope<T> {
  return meta === undefined ? { ok: true, data } : { ok: true, data, meta };
}

/** Build an error envelope object. */
export function fail(
  error: string,
  status: number,
  code?: string,
  meta?: EnvelopeMeta,
): ErrorEnvelope {
  const out: ErrorEnvelope = { ok: false, error, status };
  if (code !== undefined) out.code = code;
  if (meta !== undefined) out.meta = meta;
  return out;
}

/** Build an offset-paginated envelope. `totalPages` is derived. */
export function page<T>(
  items: T[],
  opts: { page: number; perPage: number; total: number; meta?: EnvelopeMeta },
): OffsetPage<T> {
  const perPage = Math.max(1, opts.perPage);
  const out: OffsetPage<T> = {
    ok: true,
    data: items,
    page: opts.page,
    perPage,
    total: opts.total,
    totalPages: Math.ceil(opts.total / perPage),
  };
  if (opts.meta !== undefined) out.meta = opts.meta;
  return out;
}

/** Build a cursor-paginated envelope. */
export function cursorPage<T>(
  items: T[],
  nextCursor: string | null,
  meta?: EnvelopeMeta,
): CursorPage<T> {
  const out: CursorPage<T> = { ok: true, data: items, nextCursor };
  if (meta !== undefined) out.meta = meta;
  return out;
}
