/**
 * `@minostack/mino/ip-restriction` — allow/deny IP filtering middleware.
 *
 * Zero dependencies, runtime-agnostic (pure string/`BigInt` matching, Fetch only).
 *
 * ```ts
 * import { Mino } from "@minostack/mino";
 * import { ipRestrict } from "@minostack/mino/ip-restriction";
 *
 * const app = new Mino();
 * app.use(ipRestrict({ allow: ["10.0.0.0/8", "::1"], deny: ["10.0.0.99"] }));
 * ```
 *
 * Evaluation: an IP in `deny` answers `403` JSON (`{ error, status, code }`)
 * and never reaches handlers; otherwise, when `allow` is non-empty and the IP
 * is not in it, the same `403` is answered; otherwise `next()` runs. Deny
 * always wins over allow.
 *
 * IP resolution reuses `clientIp` from `./rate-limit.js` (single source of
 * trust logic): server-set `x-mino-peer` wins, `X-Forwarded-For` is honored
 * only when `trustProxy` allows, otherwise the `"global"` fallback applies
 * (an unparseable fallback never matches an entry, so a non-empty `allow`
 * list fails closed for it).
 *
 * Matching is pure TS: IPv4 exact (`1.2.3.4`) + `a.b.c.d/n` bitmask compare,
 * IPv6 exact + `/n` prefix compare via `BigInt` (`::` expansion, and
 * `::ffff:a.b.c.d` tails additionally match IPv4 entries). An IPv4 entry never
 * matches a native IPv6 peer and vice versa. Malformed entries throw a plain
 * `Error` at middleware construction (fail fast — never per request). Client
 * IPs are trust signals, never logged (no secrets/PII in logs).
 */

import { clientIp } from "./rate-limit.js";
import type { Context } from "./context.js";
import type { Handler } from "./types.js";

export interface IpRestrictOptions {
  /** IPs/CIDRs allowed through. Empty/omitted = allow all (deny still applies). */
  allow?: string[];
  /** IPs/CIDRs rejected with `403` (evaluated before `allow`). */
  deny?: string[];
  /**
   * Proxy trust for `X-Forwarded-For` — same semantics as
   * `MinoOptions.trustProxy`. Untrusted values are always ignored
   * (client-spoofable). Default: only `x-mino-peer` is trusted.
   */
  trustProxy?: boolean | number;
  /** Custom `403` message (default `"Forbidden"`). */
  message?: string;
}

type Matcher = { family: 4; net: number; bits: number } | { family: 6; net: bigint; bits: number };

/** Parse dotted-quad IPv4 into a uint32 number; `null` when not IPv4. */
function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (p.length === 0 || p.length > 3 || !/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Parse IPv6 (with `::` expansion and embedded IPv4 tails) into a 128-bit `BigInt`. */
function parseIPv6(s: string): bigint | null {
  let text = s;
  // Embedded IPv4 tail (`::ffff:192.0.2.1`): fold it into two hex groups.
  if (text.includes(".")) {
    const i = text.lastIndexOf(":");
    if (i === -1) return null;
    const tail = parseIPv4(text.slice(i + 1));
    if (tail === null) return null;
    text = `${text.slice(0, i)}:${((tail >>> 16) & 0xffff).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  // split() always yields ≥1 element; the cast keeps noUncheckedIndexedAccess honest.
  const first = halves[0] as string;
  const head = first === "" ? [] : first.split(":");
  let tailGroups: string[] = [];
  if (halves.length === 2) {
    const second = halves[1] as string; // length checked above
    tailGroups = second === "" ? [] : second.split(":");
  }
  const fill = 8 - head.length - tailGroups.length;
  // `::` must compress at least one group; without it all 8 must be present.
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  let out = 0n;
  const groups = [...head];
  for (let i = 0; i < fill; i++) groups.push("0");
  groups.push(...tailGroups);
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) + BigInt(parseInt(g, 16));
  }
  return out;
}

/** Parse one `allow`/`deny` entry; throws a plain `Error` when malformed. */
function parseEntry(entry: string): Matcher {
  const slash = entry.indexOf("/");
  if (slash === -1) {
    const v4 = parseIPv4(entry);
    if (v4 !== null) return { family: 4, net: v4, bits: 32 };
    const v6 = parseIPv6(entry);
    if (v6 !== null) return { family: 6, net: v6, bits: 128 };
    throw new Error(`ipRestrict: invalid IP address: "${entry}"`);
  }
  const addr = entry.slice(0, slash);
  const prefix = entry.slice(slash + 1);
  if (!/^\d+$/.test(prefix)) throw new Error(`ipRestrict: invalid CIDR prefix: "${entry}"`);
  const bits = Number(prefix);
  const v4 = parseIPv4(addr);
  if (v4 !== null) {
    if (bits > 32) throw new Error(`ipRestrict: invalid IPv4 prefix: "${entry}"`);
    return { family: 4, net: v4, bits };
  }
  const v6 = parseIPv6(addr);
  if (v6 !== null) {
    if (bits > 128) throw new Error(`ipRestrict: invalid IPv6 prefix: "${entry}"`);
    return { family: 6, net: v6, bits };
  }
  throw new Error(`ipRestrict: invalid CIDR address: "${entry}"`);
}

function matchV4(ip: number, m: Matcher): boolean {
  if (m.family !== 4) return false;
  if (m.bits === 0) return true;
  const shift = 32 - m.bits;
  return ip >>> shift === m.net >>> shift;
}

function matchV6(ip: bigint, m: Matcher): boolean {
  if (m.family !== 6) return false;
  if (m.bits === 0) return true;
  const shift = BigInt(128 - m.bits);
  return ip >> shift === m.net >> shift;
}

/** True when the peer string matches any entry (unparseable peers never match). */
function peerMatches(peer: string, list: Matcher[]): boolean {
  const v4 = parseIPv4(peer);
  if (v4 !== null) return list.some((m) => matchV4(v4, m));
  const v6 = parseIPv6(peer);
  if (v6 === null) return false;
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) additionally matches IPv4 entries.
  if (v6 >> 32n === 0xffffn && list.some((m) => matchV4(Number(v6 & 0xffffffffn), m))) {
    return true;
  }
  return list.some((m) => matchV6(v6, m));
}

function forbidden(message: string): Response {
  return new Response(JSON.stringify({ error: message, status: 403, code: "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function ipRestrict(opts: IpRestrictOptions = {}): Handler {
  // Fail fast: malformed entries throw here at construction, not per request.
  const allow = (opts.allow ?? []).map(parseEntry);
  const deny = (opts.deny ?? []).map(parseEntry);
  const message = opts.message ?? "Forbidden";
  return async (c, next) => {
    const ip = clientIp(c as unknown as Context, opts.trustProxy);
    if (peerMatches(ip, deny)) {
      const blocked = forbidden(message);
      c.setResponse(blocked);
      return blocked;
    }
    if (allow.length > 0 && !peerMatches(ip, allow)) {
      const blocked = forbidden(message);
      c.setResponse(blocked);
      return blocked;
    }
    await next();
  };
}
