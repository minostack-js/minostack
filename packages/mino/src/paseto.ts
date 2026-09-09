/**
 * `@minostack/mino/paseto` — PASETO v4 tokens (`v4.local` + `v4.public`).
 *
 * Zero dependencies, runtime-agnostic. Symmetric crypto (BLAKE2b, XChaCha20)
 * is implemented in pure TypeScript; Ed25519 goes through SubtleCrypto.
 * JWT remains supported — see `token()` in `@minostack/mino/jwt` for a
 * middleware that accepts either format.
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { paseto } from "@minostack/mino/paseto";
 *
 * const app = new Mino();
 * // Encrypted tokens:
 * app.use(paseto({ secret: localKey }));
 * // ...or signed tokens: paseto({ publicKey })
 * ```
 *
 * Key formats: `v4.local` takes a 32-byte symmetric key; `v4.public` takes a
 * 32-byte public key for verify and a 64-byte `seed || pub` secret key for
 * sign (as returned by `generatePublicKeypair`). All failures throw
 * `UnauthorizedError` with generic messages — never token or key bytes.
 */

import { UnauthorizedError } from "./errors.js";
import type { Context } from "./context.js";
import type { Handler } from "./types.js";

// ─────────────────────────────────────────────────────────────────
// base64url (unpadded, strict: rejects `=` and non-alphabet chars)
// ─────────────────────────────────────────────────────────────────

const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64uAt(i: number): string {
  return B64U[i] as string;
}

export function bytesToBase64Url(bytes: Uint8Array<ArrayBufferLike>): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    const c = bytes[i + 2] as number;
    out +=
      b64uAt(a >> 2) +
      b64uAt(((a & 3) << 4) | (b >> 4)) +
      b64uAt(((b & 15) << 2) | (c >> 6)) +
      b64uAt(c & 63);
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const a = bytes[i] as number;
    out += b64uAt(a >> 2) + b64uAt((a & 3) << 4);
  } else if (rem === 2) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    out += b64uAt(a >> 2) + b64uAt(((a & 3) << 4) | (b >> 4)) + b64uAt((b & 15) << 2);
  }
  return out;
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBufferLike> {
  if (s.length % 4 === 1) throw new Error("Invalid base64url");
  const lut = new Map<string, number>();
  for (let i = 0; i < 64; i++) lut.set(B64U[i] as string, i);
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = lut.get(ch);
    if (v === undefined) throw new Error("Invalid base64url");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error("Invalid base64url");
  return new Uint8Array(out);
}

function utf8(s: string): Uint8Array<ArrayBufferLike> {
  return new TextEncoder().encode(s);
}

function toBytes(input: string | Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  return typeof input === "string" ? utf8(input) : input;
}

function concat(...parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function constEq(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

function le64(n: number): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

/** Pre-Authentication Encoding: `LE64(count) || LE64(len)||piece ...` */
export function pae(pieces: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBufferLike> {
  const parts: Uint8Array<ArrayBufferLike>[] = [le64(pieces.length)];
  for (const p of pieces) parts.push(le64(p.length), p);
  return concat(...parts);
}

// ─────────────────────────────────────────────────────────────────
// BLAKE2b (RFC 7693) — keyed MAC + variable digest, pure BigInt impl
// ─────────────────────────────────────────────────────────────────

const BLAKE_IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

const BLAKE_SIGMA: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const MASK64 = 0xffffffffffffffffn;

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function blakeCompress(
  h: bigint[],
  block: Uint8Array<ArrayBufferLike>,
  t: bigint,
  last: boolean,
): bigint[] {
  const m: bigint[] = [];
  const dv = new DataView(block.buffer, block.byteOffset, 128);
  for (let i = 0; i < 16; i++) m.push(dv.getBigUint64(i * 8, true));
  const v = [...h, ...BLAKE_IV];
  v[12] = (v[12] as bigint) ^ (t & MASK64);
  v[13] = (v[13] as bigint) ^ (t >> 64n);
  if (last) v[14] = (v[14] as bigint) ^ MASK64;
  const G = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + x) & MASK64;
    v[d] = rotr64((v[d] as bigint) ^ (v[a] as bigint), 32n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK64;
    v[b] = rotr64((v[b] as bigint) ^ (v[c] as bigint), 24n);
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + y) & MASK64;
    v[d] = rotr64((v[d] as bigint) ^ (v[a] as bigint), 16n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK64;
    v[b] = rotr64((v[b] as bigint) ^ (v[c] as bigint), 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = BLAKE_SIGMA[r] as number[];
    G(0, 4, 8, 12, m[s[0] as number] as bigint, m[s[1] as number] as bigint);
    G(1, 5, 9, 13, m[s[2] as number] as bigint, m[s[3] as number] as bigint);
    G(2, 6, 10, 14, m[s[4] as number] as bigint, m[s[5] as number] as bigint);
    G(3, 7, 11, 15, m[s[6] as number] as bigint, m[s[7] as number] as bigint);
    G(0, 5, 10, 15, m[s[8] as number] as bigint, m[s[9] as number] as bigint);
    G(1, 6, 11, 12, m[s[10] as number] as bigint, m[s[11] as number] as bigint);
    G(2, 7, 8, 13, m[s[12] as number] as bigint, m[s[13] as number] as bigint);
    G(3, 4, 9, 14, m[s[14] as number] as bigint, m[s[15] as number] as bigint);
  }
  return h.map((x, i) => (x ^ (v[i] as bigint) ^ (v[i + 8] as bigint)) & MASK64);
}

export function blake2b(
  message: Uint8Array<ArrayBufferLike>,
  key: Uint8Array<ArrayBufferLike> = new Uint8Array(0),
  outlen = 64,
): Uint8Array<ArrayBufferLike> {
  if (outlen < 1 || outlen > 64) throw new Error("Invalid BLAKE2b digest length");
  if (key.length > 128) throw new Error("Invalid BLAKE2b key length");
  const param = new Uint8Array(64);
  param[0] = outlen;
  param[1] = key.length;
  param[2] = 1;
  param[3] = 1;
  const pdv = new DataView(param.buffer);
  let h: bigint[] = [];
  for (let i = 0; i < 8; i++) h.push((BLAKE_IV[i] as bigint) ^ pdv.getBigUint64(i * 8, true));
  const body = key.length > 0 ? concat(key, new Uint8Array(128 - key.length), message) : message;
  let t = 0n;
  if (body.length === 0) {
    h = blakeCompress(h, new Uint8Array(128), 0n, true);
  } else {
    let off = 0;
    while (off < body.length) {
      const chunk = body.subarray(off, off + 128);
      off += chunk.length;
      t += BigInt(chunk.length);
      const block = chunk.length < 128 ? concat(chunk, new Uint8Array(128 - chunk.length)) : chunk;
      h = blakeCompress(h, block, t, off >= body.length);
    }
  }
  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  h.forEach((x, i) => odv.setBigUint64(i * 8, x, true));
  return out.subarray(0, outlen);
}

// ─────────────────────────────────────────────────────────────────
// ChaCha20 + HChaCha20 + XChaCha20 (RFC 8439 §2, draft-arciszewski)
// ─────────────────────────────────────────────────────────────────

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function chachaBlock(
  key: Uint8Array<ArrayBufferLike>,
  counter: number,
  nonce: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const kv = new DataView(key.buffer, key.byteOffset, 32);
  const nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
  const s = [
    0x61707865,
    0x3320646e,
    0x79622d32,
    0x6b206574,
    kv.getUint32(0, true),
    kv.getUint32(4, true),
    kv.getUint32(8, true),
    kv.getUint32(12, true),
    kv.getUint32(16, true),
    kv.getUint32(20, true),
    kv.getUint32(24, true),
    kv.getUint32(28, true),
    counter >>> 0,
    nv.getUint32(0, true),
    nv.getUint32(4, true),
    nv.getUint32(8, true),
  ];
  const w = [...s];
  const QR = (a: number, b: number, c: number, d: number): void => {
    w[a] = ((w[a] as number) + (w[b] as number)) >>> 0;
    w[d] = rotl32((w[d] as number) ^ (w[a] as number), 16);
    w[c] = ((w[c] as number) + (w[d] as number)) >>> 0;
    w[b] = rotl32((w[b] as number) ^ (w[c] as number), 12);
    w[a] = ((w[a] as number) + (w[b] as number)) >>> 0;
    w[d] = rotl32((w[d] as number) ^ (w[a] as number), 8);
    w[c] = ((w[c] as number) + (w[d] as number)) >>> 0;
    w[b] = rotl32((w[b] as number) ^ (w[c] as number), 7);
  };
  for (let i = 0; i < 10; i++) {
    QR(0, 4, 8, 12);
    QR(1, 5, 9, 13);
    QR(2, 6, 10, 14);
    QR(3, 7, 11, 15);
    QR(0, 5, 10, 15);
    QR(1, 6, 11, 12);
    QR(2, 7, 8, 13);
    QR(3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 16; i++)
    ov.setUint32(i * 4, ((w[i] as number) + (s[i] as number)) >>> 0, true);
  return out;
}

function hchacha20(
  key: Uint8Array<ArrayBufferLike>,
  nonce16: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const kv = new DataView(key.buffer, key.byteOffset, 32);
  const nv = new DataView(nonce16.buffer, nonce16.byteOffset, 16);
  const s = [
    0x61707865,
    0x3320646e,
    0x79622d32,
    0x6b206574,
    kv.getUint32(0, true),
    kv.getUint32(4, true),
    kv.getUint32(8, true),
    kv.getUint32(12, true),
    kv.getUint32(16, true),
    kv.getUint32(20, true),
    kv.getUint32(24, true),
    kv.getUint32(28, true),
    nv.getUint32(0, true),
    nv.getUint32(4, true),
    nv.getUint32(8, true),
    nv.getUint32(12, true),
  ];
  const w = [...s];
  const QR = (a: number, b: number, c: number, d: number): void => {
    w[a] = ((w[a] as number) + (w[b] as number)) >>> 0;
    w[d] = rotl32((w[d] as number) ^ (w[a] as number), 16);
    w[c] = ((w[c] as number) + (w[d] as number)) >>> 0;
    w[b] = rotl32((w[b] as number) ^ (w[c] as number), 12);
    w[a] = ((w[a] as number) + (w[b] as number)) >>> 0;
    w[d] = rotl32((w[d] as number) ^ (w[a] as number), 8);
    w[c] = ((w[c] as number) + (w[d] as number)) >>> 0;
    w[b] = rotl32((w[b] as number) ^ (w[c] as number), 7);
  };
  for (let i = 0; i < 10; i++) {
    QR(0, 4, 8, 12);
    QR(1, 5, 9, 13);
    QR(2, 6, 10, 14);
    QR(3, 7, 11, 15);
    QR(0, 5, 10, 15);
    QR(1, 6, 11, 12);
    QR(2, 7, 8, 13);
    QR(3, 4, 9, 14);
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (const i of [0, 1, 2, 3, 12, 13, 14, 15]) {
    ov.setUint32([0, 1, 2, 3, 12, 13, 14, 15].indexOf(i) * 4, w[i] as number, true);
  }
  return out;
}

export function xchacha20(
  message: Uint8Array<ArrayBufferLike>,
  nonce24: Uint8Array<ArrayBufferLike>,
  key: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (nonce24.length !== 24) throw new Error("Invalid XChaCha20 nonce length");
  if (key.length !== 32) throw new Error("Invalid XChaCha20 key length");
  const subkey = hchacha20(key, nonce24.subarray(0, 16));
  const nonce12 = concat(new Uint8Array(4), nonce24.subarray(16, 24));
  const out = new Uint8Array(message.length);
  let counter = 0;
  for (let off = 0; off < message.length; off += 64) {
    const ks = chachaBlock(subkey, counter, nonce12);
    counter = (counter + 1) >>> 0;
    const chunk = message.subarray(off, off + 64);
    for (let i = 0; i < chunk.length; i++) out[off + i] = (chunk[i] as number) ^ (ks[i] as number);
  }
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBufferLike> {
  const g = globalThis.crypto;
  if (!g || typeof g.getRandomValues !== "function")
    throw new Error("Secure randomness unavailable");
  return g.getRandomValues(new Uint8Array(n));
}

function subtleEd(): SubtleCrypto {
  const g = globalThis.crypto;
  if (!g || !g.subtle) throw new Error("SubtleCrypto unavailable");
  return g.subtle;
}

// ─────────────────────────────────────────────────────────────────
// v4.local — authenticated encryption (spec: XChaCha20 + BLAKE2b-MAC)
// ─────────────────────────────────────────────────────────────────

const LOCAL_HEADER = "v4.local.";
const PUBLIC_HEADER = "v4.public.";

export interface PasetoCryptoOptions {
  footer?: string | Uint8Array<ArrayBufferLike>;
  assertion?: string | Uint8Array<ArrayBufferLike>;
}

export interface PasetoEncryptOptions extends PasetoCryptoOptions {
  /** Test-only nonce override (32 bytes). Random when omitted. */
  nonce?: Uint8Array<ArrayBufferLike>;
}

function splitLocalToken(
  token: string,
  expectedFooter: Uint8Array<ArrayBufferLike>,
): {
  n: Uint8Array<ArrayBufferLike>;
  c: Uint8Array<ArrayBufferLike>;
  t: Uint8Array<ArrayBufferLike>;
} {
  if (!token.startsWith(LOCAL_HEADER)) throw new UnauthorizedError("Invalid token");
  const rest = token.slice(LOCAL_HEADER.length);
  const dot = rest.indexOf(".");
  let payloadB64 = rest;
  if (dot !== -1) {
    const footerB64 = rest.slice(dot + 1);
    let footer: Uint8Array<ArrayBufferLike>;
    try {
      footer = base64UrlToBytes(footerB64);
    } catch {
      throw new UnauthorizedError("Invalid token");
    }
    if (!constEq(footer, expectedFooter)) throw new UnauthorizedError("Invalid token");
    payloadB64 = rest.slice(0, dot);
  } else if (expectedFooter.length > 0) {
    throw new UnauthorizedError("Invalid token");
  }
  let raw: Uint8Array<ArrayBufferLike>;
  try {
    raw = base64UrlToBytes(payloadB64);
  } catch {
    throw new UnauthorizedError("Invalid token");
  }
  if (raw.length < 64) throw new UnauthorizedError("Invalid token");
  return {
    n: raw.subarray(0, 32),
    c: raw.subarray(32, raw.length - 32),
    t: raw.subarray(raw.length - 32),
  };
}

export async function encrypt(
  key: Uint8Array<ArrayBufferLike>,
  message: string | Uint8Array<ArrayBufferLike>,
  opts: PasetoEncryptOptions = {},
): Promise<string> {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new UnauthorizedError("Invalid key");
  }
  const m = toBytes(message);
  const f = opts.footer === undefined ? new Uint8Array(0) : toBytes(opts.footer);
  const i = opts.assertion === undefined ? new Uint8Array(0) : toBytes(opts.assertion);
  const n = opts.nonce !== undefined ? opts.nonce : randomBytes(32);
  if (!(n instanceof Uint8Array) || n.length !== 32) throw new Error("Invalid nonce");
  const h = utf8(LOCAL_HEADER);
  const tmp = blake2b(concat(utf8("paseto-encryption-key"), n), key, 56);
  const ek = tmp.subarray(0, 32);
  const n2 = tmp.subarray(32, 56);
  const ak = blake2b(concat(utf8("paseto-auth-key-for-aead"), n), key, 32);
  const c = xchacha20(m, n2, ek);
  const preAuth = pae([h, n, c, f, i]);
  const t = blake2b(preAuth, ak, 32);
  const body = bytesToBase64Url(concat(n, c, t));
  return f.length === 0
    ? `${LOCAL_HEADER}${body}`
    : `${LOCAL_HEADER}${body}.${bytesToBase64Url(f)}`;
}

export async function decrypt(
  key: Uint8Array<ArrayBufferLike>,
  token: string,
  opts: PasetoCryptoOptions = {},
): Promise<Uint8Array<ArrayBufferLike>> {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new UnauthorizedError("Invalid key");
  }
  if (typeof token !== "string") throw new UnauthorizedError("Invalid token");
  const f = opts.footer === undefined ? new Uint8Array(0) : toBytes(opts.footer);
  const i = opts.assertion === undefined ? new Uint8Array(0) : toBytes(opts.assertion);
  const { n, c, t } = splitLocalToken(token, f);
  const h = utf8(LOCAL_HEADER);
  const tmp = blake2b(concat(utf8("paseto-encryption-key"), n), key, 56);
  const ek = tmp.subarray(0, 32);
  const n2 = tmp.subarray(32, 56);
  const ak = blake2b(concat(utf8("paseto-auth-key-for-aead"), n), key, 32);
  const t2 = blake2b(pae([h, n, c, f, i]), ak, 32);
  if (!constEq(t, t2)) throw new UnauthorizedError("Invalid token");
  return xchacha20(c, n2, ek);
}

// ─────────────────────────────────────────────────────────────────
// v4.public — Ed25519 signatures (via SubtleCrypto)
// ─────────────────────────────────────────────────────────────────

export interface PasetoKeypair {
  /** 64 bytes: 32-byte seed || 32-byte public key. */
  secretKey: Uint8Array<ArrayBufferLike>;
  publicKey: Uint8Array<ArrayBufferLike>;
}

export function generateLocalKey(): Uint8Array<ArrayBufferLike> {
  return randomBytes(32);
}

export async function generatePublicKeypair(): Promise<PasetoKeypair> {
  let kp: CryptoKeyPair;
  try {
    kp = await subtleEd().generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  } catch {
    throw new Error("Ed25519 unavailable in this runtime");
  }
  const jwk = (await subtleEd().exportKey("jwk", kp.privateKey)) as { x?: string; d?: string };
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("Ed25519 unavailable in this runtime");
  }
  const pub = base64UrlToBytes(jwk.x);
  const seed = base64UrlToBytes(jwk.d);
  return { secretKey: concat(seed, pub), publicKey: pub };
}

async function importEdKey(
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string; d?: string },
  use: "sign" | "verify",
): Promise<CryptoKey> {
  try {
    return await subtleEd().importKey("jwk", jwk, { name: "Ed25519" }, false, [use]);
  } catch {
    throw new Error("Ed25519 unavailable in this runtime");
  }
}

export async function sign(
  secretKey: Uint8Array<ArrayBufferLike>,
  message: string | Uint8Array<ArrayBufferLike>,
  opts: PasetoCryptoOptions = {},
): Promise<string> {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 64) {
    throw new UnauthorizedError("Invalid key");
  }
  const m = toBytes(message);
  const f = opts.footer === undefined ? new Uint8Array(0) : toBytes(opts.footer);
  const i = opts.assertion === undefined ? new Uint8Array(0) : toBytes(opts.assertion);
  const h = utf8(PUBLIC_HEADER);
  const m2 = pae([h, m, f, i]);
  const seed = secretKey.subarray(0, 32);
  const pub = secretKey.subarray(32, 64);
  const key = await importEdKey(
    { kty: "OKP", crv: "Ed25519", x: bytesToBase64Url(pub), d: bytesToBase64Url(seed) },
    "sign",
  );
  let sig: ArrayBuffer;
  try {
    sig = await subtleEd().sign({ name: "Ed25519" }, key, new Uint8Array(m2));
  } catch {
    throw new UnauthorizedError("Invalid key");
  }
  const body = bytesToBase64Url(concat(m, new Uint8Array(sig)));
  return f.length === 0
    ? `${PUBLIC_HEADER}${body}`
    : `${PUBLIC_HEADER}${body}.${bytesToBase64Url(f)}`;
}

export async function verify(
  publicKey: Uint8Array<ArrayBufferLike>,
  token: string,
  opts: PasetoCryptoOptions = {},
): Promise<Uint8Array<ArrayBufferLike>> {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new UnauthorizedError("Invalid key");
  }
  if (typeof token !== "string" || !token.startsWith(PUBLIC_HEADER)) {
    throw new UnauthorizedError("Invalid token");
  }
  const f = opts.footer === undefined ? new Uint8Array(0) : toBytes(opts.footer);
  const i = opts.assertion === undefined ? new Uint8Array(0) : toBytes(opts.assertion);
  const rest = token.slice(PUBLIC_HEADER.length);
  const dot = rest.indexOf(".");
  let payloadB64 = rest;
  if (dot !== -1) {
    let footer: Uint8Array<ArrayBufferLike>;
    try {
      footer = base64UrlToBytes(rest.slice(dot + 1));
    } catch {
      throw new UnauthorizedError("Invalid token");
    }
    if (!constEq(footer, f)) throw new UnauthorizedError("Invalid token");
    payloadB64 = rest.slice(0, dot);
  } else if (f.length > 0) {
    throw new UnauthorizedError("Invalid token");
  }
  let raw: Uint8Array<ArrayBufferLike>;
  try {
    raw = base64UrlToBytes(payloadB64);
  } catch {
    throw new UnauthorizedError("Invalid token");
  }
  if (raw.length < 64) throw new UnauthorizedError("Invalid token");
  const m = raw.subarray(0, raw.length - 64);
  const s = raw.subarray(raw.length - 64);
  const m2 = pae([utf8(PUBLIC_HEADER), m, f, i]);
  const key = await importEdKey(
    { kty: "OKP", crv: "Ed25519", x: bytesToBase64Url(publicKey) },
    "verify",
  );
  let ok = false;
  try {
    ok = await subtleEd().verify({ name: "Ed25519" }, key, new Uint8Array(s), new Uint8Array(m2));
  } catch {
    throw new UnauthorizedError("Invalid signature");
  }
  if (!ok) throw new UnauthorizedError("Invalid signature");
  return m;
}

// ─────────────────────────────────────────────────────────────────
// Middleware — accepts v4.local (decrypt) and v4.public (verify)
// ─────────────────────────────────────────────────────────────────

export type PasetoPayload = Record<string, unknown>;

export interface PasetoMiddlewareOptions extends PasetoCryptoOptions {
  /** 32-byte key for `v4.local` tokens. */
  secret?: Uint8Array<ArrayBufferLike>;
  /** 32-byte public key for `v4.public` tokens. */
  publicKey?: Uint8Array<ArrayBufferLike>;
  /** Cookie name to read the token from (falls back to the header). */
  cookie?: string;
  /** Header carrying the token (default `"authorization"`, Bearer scheme). */
  header?: string;
  /** Required `iss`. */
  issuer?: string | string[];
  /** Required `aud`. */
  audience?: string | string[];
  /** Leeway in seconds for time claims. */
  clockToleranceSec?: number;
}

/** State key the verified payload is stored under (`c.get("pasetoPayload")`). */
export const PASETO_PAYLOAD_KEY = "pasetoPayload";

function assertPasetoClaims(payload: PasetoPayload, opts: PasetoMiddlewareOptions): void {
  const now = Math.floor(Date.now() / 1000);
  const tol = opts.clockToleranceSec ?? 0;
  const exp = payload["exp"];
  if (exp !== undefined) {
    if (typeof exp !== "number" || !Number.isFinite(exp))
      throw new UnauthorizedError("Invalid exp claim");
    if (now > exp + tol) throw new UnauthorizedError("Token expired");
  }
  const nbf = payload["nbf"];
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isFinite(nbf))
      throw new UnauthorizedError("Invalid nbf claim");
    if (now + tol < nbf) throw new UnauthorizedError("Token not yet valid");
  }
  const iat = payload["iat"];
  if (iat !== undefined) {
    if (typeof iat !== "number" || !Number.isFinite(iat))
      throw new UnauthorizedError("Invalid iat claim");
    if (iat > now + tol) throw new UnauthorizedError("Invalid iat claim");
  }
  if (opts.issuer !== undefined) {
    const expected = Array.isArray(opts.issuer) ? opts.issuer : [opts.issuer];
    if (typeof payload["iss"] !== "string" || !expected.includes(payload["iss"] as string)) {
      throw new UnauthorizedError("Invalid issuer");
    }
  }
  if (opts.audience !== undefined) {
    const expected = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
    const actual = payload["aud"];
    const actuals = Array.isArray(actual) ? actual : [actual];
    if (!actuals.some((a) => typeof a === "string" && expected.includes(a))) {
      throw new UnauthorizedError("Invalid audience");
    }
  }
}

function unauthorized(c: Context, message = "Unauthorized"): Response {
  const res = new Response(JSON.stringify({ error: message, status: 401, code: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  c.setResponse(res);
  return res;
}

function extractToken(c: Context, headerName: string, cookieName?: string): string | undefined {
  if (cookieName) {
    const cookieHeader = c.header("cookie");
    if (cookieHeader) {
      const eq = cookieHeader.split(";");
      for (const part of eq) {
        const idx = part.indexOf("=");
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === cookieName) {
          try {
            return decodeURIComponent(part.slice(idx + 1).trim());
          } catch {
            return undefined;
          }
        }
      }
    }
  }
  const h = c.header(headerName);
  if (h) {
    const bits = h.trim().split(/\s+/);
    if (bits.length === 2 && /^bearer$/i.test(bits[0] as string)) return bits[1] as string;
  }
  return undefined;
}

/**
 * Token middleware for PASETO v4. Reads `Authorization: Bearer <token>` (or
 * the configured cookie, with header fallback), decrypts `v4.local` with
 * `secret` or verifies `v4.public` with `publicKey`, JSON-parses the payload,
 * checks time claims, stores via `c.set("pasetoPayload", payload)`, and calls
 * `next()`. Failures return `401` JSON directly.
 */
export function paseto(opts: PasetoMiddlewareOptions): Handler {
  if (!opts.secret && !opts.publicKey) {
    throw new Error("paseto middleware requires secret or publicKey");
  }
  const headerName = opts.header ?? "authorization";

  return async (c, next) => {
    const raw = extractToken(c as unknown as Context, headerName, opts.cookie);
    if (!raw) return unauthorized(c as unknown as Context);
    try {
      let bytes: Uint8Array<ArrayBufferLike>;
      if (raw.startsWith(LOCAL_HEADER)) {
        if (!opts.secret) return unauthorized(c as unknown as Context);
        bytes = await decrypt(opts.secret, raw, { footer: opts.footer, assertion: opts.assertion });
      } else if (raw.startsWith(PUBLIC_HEADER)) {
        if (!opts.publicKey) return unauthorized(c as unknown as Context);
        bytes = await verify(opts.publicKey, raw, {
          footer: opts.footer,
          assertion: opts.assertion,
        });
      } else {
        return unauthorized(c as unknown as Context);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return unauthorized(c as unknown as Context, "Invalid token");
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return unauthorized(c as unknown as Context, "Invalid token");
      }
      assertPasetoClaims(payload as PasetoPayload, opts);
      (c as unknown as Context).set(PASETO_PAYLOAD_KEY, payload);
      await next();
      return;
    } catch (e) {
      if (e instanceof UnauthorizedError) return unauthorized(c as unknown as Context, e.message);
      return unauthorized(c as unknown as Context);
    }
  };
}
