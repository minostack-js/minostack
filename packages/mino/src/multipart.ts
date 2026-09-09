/**
 * `@minostack/mino/multipart` — streaming RFC 7578 `multipart/form-data` parser.
 *
 * Zero dependencies, runtime-agnostic (Fetch `Request` body stream only — no
 * `node:*`, no `req.formData()`). The native `req.formData()` buffers whole
 * files in memory; `parseMultipart` instead yields each part's bytes
 * incrementally as they arrive, so a large upload never sits fully in RAM.
 *
 * ```ts
 * import { parseMultipart, partText } from "@minostack/mino/multipart";
 *
 * app.post("/upload", async (c) => {
 *   const files: Array<{ name: string; size: number }> = [];
 *   for await (const part of parseMultipart(c.req)) {
 *     if (part.filename !== undefined) {
 *       // Stream file bytes onward (disk, S3, …) without buffering them.
 *       let size = 0;
 *       for await (const chunk of part.body) size += chunk.byteLength;
 *       files.push({ name: part.filename, size });
 *     } else {
 *       const value = await partText(part); // small text field
 *       // …use value…
 *     }
 *   }
 *   return c.json({ files });
 * });
 * ```
 *
 * Streaming search (correctness over cleverness): the body is scanned for
 * `\r\n--boundary` with a plain overlap-memmem; the last
 * `boundary.length + 4` bytes are never emitted until the next chunk arrives,
 * so a delimiter split across chunk boundaries is always found, and binary
 * content containing a boundary-like prefix with an invalid suffix is treated
 * as data, not a delimiter. Preamble/epilogue are ignored; `--boundary--`
 * ends iteration. Part headers are capped at 8kb per part (400 past the cap).
 * A part without a `name` is skipped. `Content-Transfer-Encoding` is ignored
 * (8bit/binary assumed — the only encodings the web platform emits).
 *
 * Limits fail fast MID-STREAM with `PayloadTooLargeError` (surfaced by Mino's
 * error handler as `{error, status: 413, code}` JSON) and stop reading the
 * request body. Nothing is logged — part names and file contents may carry
 * PII and must never reach logs.
 */

import { BadRequestError, PayloadTooLargeError } from "./errors.js";

/** Options for {@link parseMultipart}. */
export interface MultipartOptions {
  /**
   * Explicit boundary, overriding the `content-type` parameter.
   * Quoted or bare; validated the same way (non-empty, ≤70 chars, no
   * control characters, no leading/trailing whitespace).
   */
  boundary?: string;
  /** Max bytes per file part (has `filename`). Default `5242880` (5MB, matches `Context` `fileSize`). */
  maxFileSize?: number;
  /** Max file parts. Default `10` (matches `Context` `fileCount`). */
  maxFiles?: number;
  /** Max named parts (files + fields). Default `100` (matches `Context` `fieldCount`). */
  maxFields?: number;
  /** Max bytes per field part (no `filename`). Default `102400` (~100kb). */
  maxFieldSize?: number;
  /** Max total part-content bytes across the whole body. Default `52428800` (50MB). */
  maxTotalBytes?: number;
}

/**
 * One parsed part. `body` streams the part's bytes incrementally — it is
 * NEVER fully buffered by the parser. Consume it fully before advancing the
 * outer `parseMultipart` iterator; any remainder is discarded for you.
 */
export interface MultipartPart {
  /**
   * `name` parameter of `Content-Disposition`, UTF-8-decoded (always present;
   * nameless parts are skipped).
   */
  readonly name: string;
  /**
   * `filename` parameter (or decoded `filename*`), UTF-8-decoded; presence
   * marks a file part. Raw UTF-8 names (what browsers send) decode correctly.
   */
  readonly filename?: string;
  /** Essence of the part `Content-Type` header (`type/subtype`, lowercased); `undefined` when absent. */
  readonly contentType?: string;
  /**
   * All part headers as parsed (names lowercased by `Headers`, values
   * byte-preserving latin1 — `name`/`filename` above are the decoded sources
   * of truth for non-ASCII values).
   */
  readonly headers: Headers;
  /** Streaming part bytes. Single-use: consume fully, then move to the next part. */
  readonly body: AsyncGenerator<Uint8Array>;
}

const DEFAULT_MAX_FILE_SIZE = 5_242_880;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_FIELDS = 100;
const DEFAULT_MAX_FIELD_SIZE = 102_400;
const DEFAULT_MAX_TOTAL_BYTES = 52_428_800;
/** Max raw header bytes per part (past the cap → `BadRequestError`, status 400). */
const MAX_PART_HEADERS = 8192;
/** Cap on spaces/tabs between a delimiter and its CRLF (transport padding). */
const MAX_TRANSPORT_PADDING = 1024;

const CR = 13;
const LF = 10;
const DASH = 45;
const SPACE = 32;
const TAB = 9;

const utf8 = new TextEncoder();

interface ResolvedLimits {
  maxFileSize: number;
  maxFiles: number;
  maxFields: number;
  maxFieldSize: number;
  maxTotalBytes: number;
}

function resolveLimits(opts: MultipartOptions): ResolvedLimits {
  return {
    maxFileSize: opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
    maxFields: opts.maxFields ?? DEFAULT_MAX_FIELDS,
    maxFieldSize: opts.maxFieldSize ?? DEFAULT_MAX_FIELD_SIZE,
    maxTotalBytes: opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
}

function assertValidBoundary(boundary: string): void {
  // Note: callers trim first, so edge whitespace is handled there; reject
  // empty/oversize/control-characters here (RFC 2046 §5.1.1: 1-70 chars).
  if (boundary.length === 0 || boundary.length > 70) {
    throw new BadRequestError("Invalid multipart boundary");
  }
  for (const ch of boundary) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) {
      throw new BadRequestError("Invalid multipart boundary");
    }
  }
}

/**
 * Resolve the boundary: explicit `opts.boundary` wins; otherwise parse
 * `content-type: multipart/form-data; boundary=…` (quoted or bare).
 * Missing/invalid → `BadRequestError` (status 400).
 */
function resolveBoundary(req: Request, explicit?: string): string {
  if (explicit !== undefined) {
    const boundary = explicit.trim();
    assertValidBoundary(boundary);
    return boundary;
  }
  const contentType = req.headers.get("content-type");
  if (contentType === null || !/multipart\/form-data/i.test(contentType)) {
    throw new BadRequestError("Expected multipart/form-data request");
  }
  const match = /boundary\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(contentType);
  const raw = match === null ? "" : (match[1] ?? match[2] ?? "").trim();
  // Unescape quoted-pairs (`\"` → `"`, `\\` → `\`).
  const boundary = raw.replace(/\\(.)/g, "$1");
  assertValidBoundary(boundary);
  return boundary;
}

// ─────────────────────────────────────────────────────────────────
// Byte scanner over the request body stream
// ─────────────────────────────────────────────────────────────────

interface ScanState {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Unconsumed bytes (kept small: headers + one chunk + delimiter tail). */
  buf: Uint8Array;
  eof: boolean;
  /** Set once the `--boundary--` close delimiter has been consumed. */
  closed: boolean;
}

/** Pull the next chunk; `false` means the stream just ended. Callers check
 * `state.eof` before pulling, so this never runs twice past the end. */
async function fill(state: ScanState): Promise<boolean> {
  const { done, value } = await state.reader.read();
  if (done) {
    state.eof = true;
    return false;
  }
  if (value.byteLength === 0) return true;
  const next = new Uint8Array(state.buf.length + value.byteLength);
  next.set(state.buf, 0);
  next.set(value, state.buf.length);
  state.buf = next;
  return true;
}

/** Naive overlap-memmem: first index of `needle` in `hay`, or -1. */
function indexOfNeedle(hay: Uint8Array, needle: Uint8Array): number {
  const hLen = hay.length;
  const nLen = needle.length;
  const last = hLen - nLen;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < nLen; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Classify the bytes after a `--boundary` match. Assumes `state.buf` starts
 * right after the boundary; consumes through the delimiter terminator.
 * - `"close"`: `--` (close delimiter; epilogue is ignored afterwards).
 * - `"next"`: optional spaces/tabs then CRLF (lone LF tolerated).
 * - `"false"`: any other byte — the match was content, not a delimiter.
 * EOF before the terminator is decidable → truncated body (400).
 */
async function readDelimiterSuffix(state: ScanState): Promise<"close" | "next" | "false"> {
  while (state.buf.length < 2 && !state.eof) {
    await fill(state);
  }
  if (state.buf[0] === DASH && state.buf[1] === DASH) {
    state.buf = state.buf.slice(2);
    return "close";
  }
  let i = 0;
  for (;;) {
    while (i < state.buf.length && (state.buf[i] === SPACE || state.buf[i] === TAB)) i++;
    if (i > MAX_TRANSPORT_PADDING) {
      throw new BadRequestError("Invalid multipart delimiter");
    }
    if (i < state.buf.length) break;
    if (state.eof) {
      throw new BadRequestError("Truncated multipart body");
    }
    await fill(state);
  }
  const c = state.buf[i];
  if (c !== CR && c !== LF) return "false";
  let end = i + 1;
  if (c === CR) {
    while (end >= state.buf.length && !state.eof) {
      await fill(state);
    }
    if (end < state.buf.length && state.buf[end] === LF) end++;
  }
  state.buf = state.buf.slice(end);
  return "next";
}

/**
 * Discard preamble until the first `--boundary`. Returns `true` when the
 * first delimiter is already the close delimiter (or no delimiter exists —
 * preamble-only/empty body yields zero parts); `false` when a part follows.
 * Unmatched bytes are discarded keeping only the delimiter-sized tail, so a
 * hostile preamble cannot grow the buffer.
 */
async function skipPreamble(
  state: ScanState,
  needle: Uint8Array,
  retain: number,
): Promise<boolean> {
  for (;;) {
    const idx = indexOfNeedle(state.buf, needle);
    if (idx !== -1) {
      state.buf = state.buf.slice(idx + needle.length);
      const kind = await readDelimiterSuffix(state);
      if (kind === "close") return true;
      if (kind === "next") return false;
      continue; // false positive inside preamble — keep discarding
    }
    if (state.eof) return true;
    // Fully scanned, no match: discard all but the retained tail (a delimiter
    // starting before the cut would be fully contained — and found), then
    // pull more bytes. The next iteration scans tail + new bytes together.
    const drop = state.buf.length - retain;
    if (drop > 0) state.buf = state.buf.slice(drop);
    await fill(state);
  }
}

/**
 * Yield a part's body bytes incrementally. Emits only bytes from a
 * fully-scanned buffer minus the retained tail, so chunks flow as they
 * arrive while a delimiter spanning the cut is never missed. Sets
 * `state.closed` when the close delimiter terminates this body.
 */
async function* scanBody(
  state: ScanState,
  delim: Uint8Array,
  retain: number,
): AsyncGenerator<Uint8Array> {
  for (;;) {
    const idx = indexOfNeedle(state.buf, delim);
    if (idx !== -1) {
      const head = state.buf.slice(0, idx);
      state.buf = state.buf.slice(idx + delim.length);
      const kind = await readDelimiterSuffix(state);
      if (kind === "close") {
        state.closed = true;
        if (head.length > 0) yield head;
        return;
      }
      if (kind === "next") {
        if (head.length > 0) yield head;
        return;
      }
      // False positive: the delimiter bytes are content — emit through them
      // (`delim` is never empty, so this always yields).
      const through = new Uint8Array(head.length + delim.length);
      through.set(head, 0);
      through.set(delim, head.length);
      yield through;
      continue;
    }
    if (state.eof) {
      throw new BadRequestError("Truncated multipart body");
    }
    // Fully scanned, no match: emit all but the retained tail (any delimiter
    // starting before the cut would be fully contained — and found — because
    // `retain >= delim.length`).
    const safe = state.buf.length - retain;
    if (safe > 0) {
      const out = state.buf.slice(0, safe);
      state.buf = state.buf.slice(safe);
      yield out;
    }
    await fill(state);
  }
}

/** Read one LF-terminated line (trailing CR stripped); `null` on clean EOF. */
async function readLine(state: ScanState): Promise<Uint8Array | null> {
  for (;;) {
    const idx = state.buf.indexOf(LF);
    if (idx !== -1) {
      const raw = state.buf.slice(0, idx);
      state.buf = state.buf.slice(idx + 1);
      return raw.length > 0 && raw[raw.length - 1] === CR ? raw.slice(0, -1) : raw;
    }
    if (state.eof) {
      if (state.buf.length === 0) return null;
      const rest = state.buf;
      state.buf = new Uint8Array(0);
      return rest.length > 0 && rest[rest.length - 1] === CR ? rest.slice(0, -1) : rest;
    }
    // Fail fast: a header line that never ends is an attack, not a header.
    if (state.buf.length > MAX_PART_HEADERS + 1024) {
      throw new BadRequestError("Part headers too large");
    }
    await fill(state);
  }
}

/** True byte-preserving latin1 decode (every byte → one char ≤ U+00FF).
 * Unlike `TextDecoder("latin1")` (which is windows-1252 and maps 0x80-0x9F
 * above U+00FF), this round-trips cleanly through `Headers` ByteStrings. */
function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}

/** Strip leading/trailing SP/TAB/CR bytes. */
function trimBytes(bytes: Uint8Array): Uint8Array {
  let start = 0;
  let end = bytes.length;
  while (start < end) {
    const b = bytes[start];
    if (b !== SPACE && b !== TAB && b !== CR) break;
    start++;
  }
  while (end > start) {
    const b = bytes[end - 1];
    if (b !== SPACE && b !== TAB && b !== CR) break;
    end--;
  }
  return bytes.slice(start, end);
}

/** Read part headers until the blank line; total capped at 8kb (400 past). */
interface PartHeaders {
  /** All part headers (byte-preserving latin1 values; see `MultipartPart`). */
  headers: Headers;
  /** Raw value bytes of the first `content-disposition` line, if any. */
  disposition?: Uint8Array;
}

async function readPartHeaders(state: ScanState): Promise<PartHeaders> {
  const headers = new Headers();
  let disposition: Uint8Array | undefined;
  let used = 0;
  for (;;) {
    const line = await readLine(state);
    if (line === null) {
      throw new BadRequestError("Truncated multipart body");
    }
    used += line.length + 2;
    if (used > MAX_PART_HEADERS) {
      throw new BadRequestError("Part headers too large");
    }
    if (line.length === 0) return { headers, disposition };
    let colon = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === 58) {
        colon = i;
        break;
      }
    }
    if (colon === -1) continue; // ignore malformed line
    const name = decodeLatin1(line.slice(0, colon)).trim().toLowerCase();
    const valueBytes = line.slice(colon + 1);
    if (name.length === 0) continue;
    try {
      headers.append(name, decodeLatin1(valueBytes).trim());
    } catch {
      // Unrepresentable value (e.g. NUL bytes) — drop the header, keep the part.
    }
    if (disposition === undefined && name === "content-disposition") {
      disposition = trimBytes(valueBytes);
    }
  }
}

/** Minimal RFC 5987 decoder for `filename*=charset'lang'pct-encoded`. */
function decodeExtValue(value: string): string | undefined {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (match === null) return undefined;
  const charset = (match[1] ?? "").trim().toLowerCase() || "utf-8";
  const data = match[2] ?? "";
  const bytes: number[] = [];
  for (let i = 0; i < data.length;) {
    const ch = data[i];
    if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) {
      bytes.push(parseInt(data.slice(i + 1, i + 3), 16));
      i += 3;
      continue;
    }
    const code = data.charCodeAt(i);
    // Non-`%` bytes here are already byte-preserving (≤ U+00FF) — keep the byte.
    bytes.push(code);
    i++;
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    // Unknown charset label — fall back to UTF-8 (a valid label never throws).
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  }
}

/** Split a disposition value on `;`, respecting quoted sections + `\` escapes. */
function splitDispositionSegments(value: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const b = value[i];
    if (inQuotes) {
      if (b === 92)
        i++; // backslash escapes the next byte
      else if (b === 34) inQuotes = false;
    } else if (b === 34) {
      inQuotes = true;
    } else if (b === 59) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/**
 * Parse `Content-Disposition: form-data; name="…"; filename="…"` at the byte
 * level. `name`/`filename` values are UTF-8-decoded (what browsers send —
 * never round-tripped through `Headers`, which enforces ByteString and would
 * drop non-latin1 names entirely). `filename*` (RFC 5987) wins when decodable.
 */
function parseDisposition(value: Uint8Array): { name?: string; filename?: string } {
  const utf8decoder = new TextDecoder();
  const segments = splitDispositionSegments(value);
  let name: string | undefined;
  let filename: string | undefined;
  let filenameStar: string | undefined;
  for (const segment of segments.slice(1)) {
    let eq = -1;
    for (let i = 0; i < segment.length; i++) {
      if (segment[i] === 61) {
        eq = i;
        break;
      }
    }
    if (eq === -1) continue;
    const key = decodeLatin1(segment.slice(0, eq)).trim().toLowerCase();
    let val = trimBytes(segment.slice(eq + 1));
    if (val.length >= 2 && val[0] === 34 && val[val.length - 1] === 34) {
      const inner = val.slice(1, -1);
      const unescaped: number[] = [];
      for (let i = 0; i < inner.length; i++) {
        const b = inner[i];
        if (b === undefined) break;
        if (b === 92 && i + 1 < inner.length) {
          i++;
          const next = inner[i];
          if (next === undefined) break;
          unescaped.push(next);
        } else {
          unescaped.push(b);
        }
      }
      val = new Uint8Array(unescaped);
    }
    if (key === "name") name = utf8decoder.decode(val);
    else if (key === "filename") filename = utf8decoder.decode(val);
    else if (key === "filename*") filenameStar = decodeLatin1(val);
  }
  // RFC 6266: `filename*` wins over `filename` when it decodes.
  if (filenameStar !== undefined) {
    const decoded = decodeExtValue(filenameStar);
    if (decoded !== undefined) filename = decoded;
  }
  return { name, filename };
}

async function cancelReader(state: ScanState): Promise<void> {
  try {
    await state.reader.cancel();
  } catch {
    // Already closed/cancelled — the thrown limit error is what matters.
  }
}

async function* iterateParts(
  req: Request,
  boundary: string,
  lim: ResolvedLimits,
): AsyncGenerator<MultipartPart> {
  if (req.body === null) return;
  const reader = req.body.getReader();
  const state: ScanState = { reader, buf: new Uint8Array(0), eof: false, closed: false };
  const boundaryBytes = utf8.encode(boundary);
  const firstNeedle = new Uint8Array(2 + boundaryBytes.length);
  firstNeedle[0] = DASH;
  firstNeedle[1] = DASH;
  firstNeedle.set(boundaryBytes, 2);
  const delim = new Uint8Array(4 + boundaryBytes.length);
  delim[0] = CR;
  delim[1] = LF;
  delim[2] = DASH;
  delim[3] = DASH;
  delim.set(boundaryBytes, 4);
  const retain = delim.length; // == boundary.length + 4
  let fileCount = 0;
  let fieldCount = 0;
  let totalBytes = 0;

  const checkTotal = async (size: number): Promise<void> => {
    totalBytes += size;
    if (totalBytes > lim.maxTotalBytes) {
      await cancelReader(state);
      throw new PayloadTooLargeError(`Multipart body exceeds limit of ${lim.maxTotalBytes} bytes`);
    }
  };

  try {
    if (await skipPreamble(state, firstNeedle, retain)) return;
    let pending: { gen: AsyncGenerator<Uint8Array>; box: { done: boolean } } | null = null;
    for (;;) {
      // Discard any body the consumer left unread (limits still enforced
      // inside the shared generator), then stop at the close delimiter.
      if (pending !== null && !pending.box.done) {
        for await (const _chunk of pending.gen) {
          // Discarded — byte caps already applied while streaming.
        }
      }
      pending = null;
      if (state.closed) return;
      const { headers, disposition } = await readPartHeaders(state);
      const { name, filename } =
        disposition === undefined
          ? { name: undefined, filename: undefined }
          : parseDisposition(disposition);
      const rawContentType = headers.get("content-type");
      const contentType =
        rawContentType === null
          ? undefined
          : rawContentType.split(";")[0]?.trim().toLowerCase() || undefined;

      if (name === undefined) {
        // Missing name → skip the part (bytes still count toward the total).
        for await (const chunk of scanBody(state, delim, retain)) {
          await checkTotal(chunk.byteLength);
        }
        if (state.closed) return;
        continue;
      }
      fieldCount++;
      if (fieldCount > lim.maxFields) {
        await cancelReader(state);
        throw new PayloadTooLargeError(`Multipart form exceeds limit of ${lim.maxFields} fields`);
      }
      const isFile = filename !== undefined;
      if (isFile) {
        fileCount++;
        if (fileCount > lim.maxFiles) {
          await cancelReader(state);
          throw new PayloadTooLargeError(`Multipart form exceeds limit of ${lim.maxFiles} files`);
        }
      }
      const perPartMax = isFile ? lim.maxFileSize : lim.maxFieldSize;
      let partBytes = 0;
      const box = { done: false };
      const gen: AsyncGenerator<Uint8Array> = (async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of scanBody(state, delim, retain)) {
          partBytes += chunk.byteLength;
          if (partBytes > perPartMax) {
            await cancelReader(state);
            throw new PayloadTooLargeError(
              isFile
                ? `File exceeds limit of ${lim.maxFileSize} bytes`
                : `Field exceeds limit of ${lim.maxFieldSize} bytes`,
            );
          }
          await checkTotal(chunk.byteLength);
          yield chunk;
        }
        box.done = true;
      })();
      pending = { gen, box };
      const part: MultipartPart = {
        name,
        headers,
        body: gen,
        ...(filename !== undefined ? { filename } : {}),
        ...(contentType !== undefined ? { contentType } : {}),
      };
      yield part;
    }
  } finally {
    await cancelReader(state);
    try {
      reader.releaseLock();
    } catch {
      // Lock already released — nothing to do.
    }
  }
}

/**
 * Stream the parts of a `multipart/form-data` request. File bytes are yielded
 * incrementally as they arrive and are NEVER fully buffered by the parser.
 * Boundary errors throw synchronously (`BadRequestError`); body/limit errors
 * throw while iterating (`PayloadTooLargeError` MID-STREAM, fail fast).
 */
export function parseMultipart(
  req: Request,
  opts: MultipartOptions = {},
): AsyncGenerator<MultipartPart> {
  const boundary = resolveBoundary(req, opts.boundary);
  return iterateParts(req, boundary, resolveLimits(opts));
}

/**
 * Collect a part's body (bounded) into one `Uint8Array`.
 * Past `maxBytes` → `PayloadTooLargeError`.
 */
export async function collectPart(part: MultipartPart, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of part.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new PayloadTooLargeError(`Part exceeds limit of ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Collect a (small) part and decode it as UTF-8 text.
 * Bounded by `maxBytes` (default `102400`); past the cap →
 * `PayloadTooLargeError`.
 */
export async function partText(
  part: MultipartPart,
  maxBytes = DEFAULT_MAX_FIELD_SIZE,
): Promise<string> {
  return new TextDecoder().decode(await collectPart(part, maxBytes));
}
