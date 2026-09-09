/**
 * `@minostack/mino/websocket` — transport-agnostic WebSocket handshake + framing.
 *
 * Zero dependencies, runtime-agnostic (WebCrypto SubtleCrypto only).
 * There is deliberately NO server handle here: adapters hijack the socket,
 * answer `101` via `websocketUpgradeResponse(await createAcceptKey(key))`,
 * then pump bytes through `encodeFrame` / `createFrameParser`.
 *
 * ```ts
 * import {
 *   isWebSocketRequest,
 *   createAcceptKey,
 *   websocketUpgradeResponse,
 *   encodeFrame,
 *   createFrameParser,
 *   Opcode,
 * } from "@minostack/mino/websocket";
 *
 * // Inside an adapter after hijacking the socket:
 * const key = req.headers.get("sec-websocket-key") ?? "";
 * const accept = await createAcceptKey(key);
 * const res101 = websocketUpgradeResponse(accept); // 101 + Upgrade/Connection/Accept
 *
 * const parser = createFrameParser((frame) => {
 *   if (frame.opcode === Opcode.Ping) socket.write(encodeFrame({ opcode: Opcode.Pong, data: frame.data }));
 *   if (frame.opcode === Opcode.Text) console.log(new TextDecoder().decode(frame.data));
 * });
 * parser.push(bytesFromSocket);
 * ```
 *
 * Codec policy: fragmentation is reassembled (continuation `0x0`), client
 * masking is removed, ping frames are only surfaced to the callback (the
 * adapter must auto-pong), pong/close pass through, 64-bit lengths supported,
 * and protocol errors (control frame > 125 bytes, fragmented control frame,
 * stray/interleaved continuation) throw a plain `Error`.
 */

/** RFC 6455 handshake GUID. */
export const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Frame opcodes. */
export const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;

export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode];

function hasToken(header: string | null, token: string): boolean {
  if (header === null) return false;
  return header.split(",").some((part) => part.trim().toLowerCase() === token);
}

/**
 * Transport-agnostic upgrade check: `GET` + `Upgrade: websocket`
 * (case-insensitive, comma-list tolerant) + non-empty `Sec-WebSocket-Key` +
 * `Sec-WebSocket-Version: 13`.
 */
export function isWebSocketRequest(req: Request): boolean {
  if (req.method.toUpperCase() !== "GET") return false;
  if (!hasToken(req.headers.get("upgrade"), "websocket")) return false;
  const key = req.headers.get("sec-websocket-key");
  if (key === null || key.trim().length === 0) return false;
  return (req.headers.get("sec-websocket-version") ?? "").trim() === "13";
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** RFC 6455 accept key: `base64(sha1(key + GUID))` via SubtleCrypto. */
export async function createAcceptKey(key: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${key.trim()}${WEBSOCKET_GUID}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-1", bytes);
  return base64Encode(new Uint8Array(digest));
}

export interface WsFrameInit {
  opcode: number;
  data?: Uint8Array | string;
  fin?: boolean;
  masked?: boolean;
}

/**
 * Encode one frame. Payloads ≥ 126 bytes use 16-bit lengths, ≥ 65536 bytes
 * use 64-bit lengths; `masked: true` applies a fresh random mask (client style).
 */
export function encodeFrame(init: WsFrameInit): Uint8Array {
  const fin = init.fin ?? true;
  const masked = init.masked ?? false;
  const data =
    typeof init.data === "string"
      ? new TextEncoder().encode(init.data)
      : (init.data ?? new Uint8Array(0));
  const len = data.byteLength;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;
  const maskOffset = headerLen;
  if (masked) headerLen += 4;
  const payloadOffset = headerLen;

  const out = new Uint8Array(headerLen + len);
  out[0] = ((fin ? 0x80 : 0) | (init.opcode & 0x0f)) & 0xff;
  if (len < 126) {
    out[1] = ((masked ? 0x80 : 0) | len) & 0xff;
  } else if (len < 65536) {
    out[1] = ((masked ? 0x80 : 0) | 126) & 0xff;
    out[2] = (len >>> 8) & 0xff;
    out[3] = len & 0xff;
  } else {
    out[1] = ((masked ? 0x80 : 0) | 127) & 0xff;
    const hi = Math.floor(len / 4294967296);
    const lo = len % 4294967296;
    out[2] = (hi >>> 24) & 0xff;
    out[3] = (hi >>> 16) & 0xff;
    out[4] = (hi >>> 8) & 0xff;
    out[5] = hi & 0xff;
    out[6] = (lo >>> 24) & 0xff;
    out[7] = (lo >>> 16) & 0xff;
    out[8] = (lo >>> 8) & 0xff;
    out[9] = lo & 0xff;
  }
  if (masked) {
    const mask = new Uint8Array(4);
    globalThis.crypto.getRandomValues(mask);
    out.set(mask, maskOffset);
    out.set(data, payloadOffset);
    for (let i = 0; i < len; i++) {
      out[payloadOffset + i] = (out[payloadOffset + i] ?? 0) ^ (mask[i % 4] ?? 0);
    }
  } else {
    out.set(data, payloadOffset);
  }
  return out;
}

export interface WsFrame {
  opcode: number;
  data: Uint8Array;
  fin: boolean;
}

export interface WsFrameParser {
  push(chunk: Uint8Array): void;
}

interface RawFrame {
  fin: boolean;
  opcode: number;
  data: Uint8Array;
}

/** Parse one frame at `off`; `undefined` when more bytes are needed. */
function tryParse(buf: Uint8Array, off: number): { frame: RawFrame; next: number } | undefined {
  if (buf.byteLength - off < 2) return undefined;
  const b0 = buf[off] ?? 0;
  const b1 = buf[off + 1] ?? 0;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let head = off + 2;
  if (len === 126) {
    if (buf.byteLength - head < 2) return undefined;
    len = ((buf[head] ?? 0) << 8) | (buf[head + 1] ?? 0);
    head += 2;
  } else if (len === 127) {
    if (buf.byteLength - head < 8) return undefined;
    const hi =
      ((buf[head] ?? 0) >>> 0) * 16777216 +
      ((buf[head + 1] ?? 0) << 16) +
      ((buf[head + 2] ?? 0) << 8) +
      (buf[head + 3] ?? 0);
    const lo =
      ((buf[head + 4] ?? 0) >>> 0) * 16777216 +
      ((buf[head + 5] ?? 0) << 16) +
      ((buf[head + 6] ?? 0) << 8) +
      (buf[head + 7] ?? 0);
    const big = hi * 4294967296 + lo;
    if (!Number.isSafeInteger(big)) throw new Error("ws: frame too large");
    len = big;
    head += 8;
  }
  const isControl = opcode >= 0x8;
  if (isControl) {
    if (!fin) throw new Error("ws: fragmented control frame");
    if (len > 125) throw new Error("ws: control frame too large");
  }
  let mask: Uint8Array | undefined;
  if (masked) {
    if (buf.byteLength - head < 4) return undefined;
    mask = buf.slice(head, head + 4);
    head += 4;
  }
  if (buf.byteLength - head < len) return undefined;
  let data = buf.slice(head, head + len);
  if (mask !== undefined) {
    const plain = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      plain[i] = (data[i] ?? 0) ^ (mask[i % 4] ?? 0);
    }
    data = plain;
  }
  return { frame: { fin, opcode, data }, next: head + len };
}

/**
 * Incremental parser: feed arbitrary socket chunks; complete messages are
 * reassembled (continuation `0x0`) and delivered to `onFrame`. Throws a plain
 * `Error` on protocol violations.
 */
export function createFrameParser(onFrame: (frame: WsFrame) => void): WsFrameParser {
  let buf = new Uint8Array(0);
  let fragOpcode = -1;
  let fragParts: Uint8Array[] = [];

  const deliver = (raw: RawFrame): void => {
    if (raw.opcode === Opcode.Continuation) {
      if (fragOpcode === -1) throw new Error("ws: unexpected continuation");
      fragParts.push(raw.data);
      if (!raw.fin) return;
      let total = 0;
      for (const part of fragParts) total += part.byteLength;
      const merged = new Uint8Array(total);
      let off = 0;
      for (const part of fragParts) {
        merged.set(part, off);
        off += part.byteLength;
      }
      const opcode = fragOpcode;
      fragOpcode = -1;
      fragParts = [];
      onFrame({ opcode, data: merged, fin: true });
      return;
    }
    if (raw.opcode >= 0x8) {
      onFrame({ opcode: raw.opcode, data: raw.data, fin: true });
      return;
    }
    if (!raw.fin) {
      if (fragOpcode !== -1) throw new Error("ws: interleaved fragmented message");
      fragOpcode = raw.opcode;
      fragParts = [raw.data];
      return;
    }
    if (fragOpcode !== -1) throw new Error("ws: interleaved fragmented message");
    onFrame({ opcode: raw.opcode, data: raw.data, fin: true });
  };

  return {
    push(chunk: Uint8Array): void {
      if (chunk.byteLength === 0) return;
      const next = new Uint8Array(buf.byteLength + chunk.byteLength);
      next.set(buf, 0);
      next.set(chunk, buf.byteLength);
      buf = next;
      let off = 0;
      for (;;) {
        const parsed = tryParse(buf, off);
        if (parsed === undefined) break;
        off = parsed.next;
        deliver(parsed.frame);
      }
      if (off > 0) buf = buf.slice(off);
    },
  };
}

/**
 * Build the `101 Switching Protocols` carrier for adapters to serialize onto
 * a hijacked socket. Pass `await createAcceptKey(clientKey)` as `acceptKey`.
 *
 * NOTE: this is a status + headers carrier typed as `Response`, not a real
 * `Response` instance — `new Response(null, { status: 101 })` throws a
 * `RangeError` (the constructor only allows 200–599). Only `.status` and
 * `.headers` are populated.
 */
export function websocketUpgradeResponse(
  acceptKey: string,
  opts: { protocol?: string } = {},
): Response {
  const headers = new Headers();
  headers.set("upgrade", "websocket");
  headers.set("connection", "Upgrade");
  headers.set("sec-websocket-accept", acceptKey);
  if (opts.protocol !== undefined) headers.set("sec-websocket-protocol", opts.protocol);
  return { status: 101, headers } as unknown as Response;
}
