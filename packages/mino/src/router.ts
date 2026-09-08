/**
 * Router — radix-inspired, correctness-first.
 * Optimizes for correctness and stable types; allocation optimizations deferred per user choice.
 * Path matching prioritizes static > param > wildcard.
 */

import type { Handler } from "./types.js";
import { BadRequestError } from "./errors.js";

export interface MatchResult {
  handlers: Handler[];
  params: Record<string, string>;
  routePath: string;
}

interface Node {
  // segment value for static node
  segment: string;
  isParam: boolean;
  isWildcard: boolean;
  paramName?: string;
  children: Map<string, Node>;
  paramChild?: Node;
  wildcardChild?: Node;
  // method -> handlers
  handlers: Map<string, Handler[]>;
  // For leaf, store full pattern for introspection
  pattern?: string;
}

export class Router {
  private root: Node = Router.createNode("", false, false);
  private routes: { method: string; path: string; handlers: Handler[] }[] = [];
  private strict: boolean;
  /**
   * Static fast-map (§14 CPU bottom-line): O(1) bypass for routes without
   * `:` or `*`. Key = normalized pathname (trailing slash stripped when
   * !strict). Keeps radix trie as source of truth; moto intact (no RegExp).
   */
  private fastStatic = new Map<string, Map<string, { handlers: Handler[]; pattern: string }>>();

  constructor(opts: { strict?: boolean } = {}) {
    this.strict = opts.strict ?? false;
  }

  private normalizeLookup(pathname: string): string {
    if (!this.strict && pathname.length > 1 && pathname.endsWith("/")) {
      return pathname.slice(0, -1);
    }
    return pathname;
  }

  private static createNode(segment: string, isParam: boolean, isWildcard: boolean): Node {
    return {
      segment,
      isParam,
      isWildcard,
      children: new Map(),
      handlers: new Map(),
    };
  }

  add(method: string, path: string, handlers: Handler[]): void {
    const m = method.toUpperCase();
    this.routes.push({ method: m, path, handlers });
    const segments = this.splitPath(path);
    let node = this.root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      if (seg === "*") {
        // wildcard — must be last segment; treat as wildcardChild
        if (i !== segments.length - 1) {
          throw new Error(`Wildcard "*" must be last segment in path "${path}"`);
        }
        if (!node.wildcardChild) {
          const wc = Router.createNode("*", false, true);
          wc.paramName = "wildcard";
          node.wildcardChild = wc;
        }
        node = node.wildcardChild;
        break;
      } else if (seg.startsWith(":")) {
        const name = seg.slice(1);
        if (!name) throw new Error(`Invalid param segment "${seg}" in path "${path}"`);
        if (!node.paramChild) {
          const pc = Router.createNode(seg, true, false);
          pc.paramName = name;
          node.paramChild = pc;
        } else {
          // param name mismatch is allowed but we keep first; could warn
        }
        node = node.paramChild;
      } else {
        let child = node.children.get(seg);
        if (!child) {
          child = Router.createNode(seg, false, false);
          node.children.set(seg, child);
        }
        node = child;
      }
    }
    const existing = node.handlers.get(m);
    if (existing) {
      // Append? For duplicate method+path, we replace by merging? Keep last wins for simplicity but we merge arrays
      // We'll concatenate — typical to allow multiple handlers for same route via separate calls
      node.handlers.set(m, [...existing, ...handlers]);
    } else {
      node.handlers.set(m, handlers);
    }
    node.pattern = path;
    // Keep fast-map in sync (static routes only). Merged array shared with trie.
    if (!path.includes(":") && !path.includes("*")) {
      const key = this.normalizeLookup(path.startsWith("/") ? path : `/${path}`);
      let inner = this.fastStatic.get(key);
      if (!inner) {
        inner = new Map();
        this.fastStatic.set(key, inner);
      }
      const merged = node.handlers.get(m) as Handler[];
      inner.set(m, { handlers: merged, pattern: path });
    }
  }

  match(method: string, pathname: string): MatchResult | null {
    const m = method.toUpperCase();
    // Fast path: static routes skip splitPath + trie walk entirely.
    // Saves array alloc + Map lookups per segment (static/text/small-json).
    const fastInner = this.fastStatic.get(this.normalizeLookup(pathname));
    if (fastInner) {
      let h = fastInner.get(m);
      if (!h && m === "HEAD") h = fastInner.get("GET");
      if (h) return { handlers: h.handlers, params: {}, routePath: h.pattern };
    }
    const segments = this.splitPath(pathname);
    const params: Record<string, string> = {};
    const res = this.matchNode(this.root, segments, 0, params);
    if (!res) return null;
    // Try exact method, else fallback for HEAD -> GET? We'll handle fallback outside.
    let handlers = res.handlers.get(m);
    if (!handlers && m === "HEAD") {
      handlers = res.handlers.get("GET");
    }
    if (!handlers) return null;
    // No spread clone: traversal is complete, Context takes ownership.
    // Saves 1 object alloc per request on hot path (§14 low allocations).
    return {
      handlers,
      params,
      routePath: res.pattern ?? pathname,
    };
  }

  /** Return all registered routes for introspection (OpenAPI, RPC, etc.) */
  getRoutes(): ReadonlyArray<{ method: string; path: string; handlers: Handler[] }> {
    return this.routes;
  }

  /** Return allowed methods for a pathname (for 405 handling) */
  allowedMethods(pathname: string): string[] {
    const segments = this.splitPath(pathname);
    const params: Record<string, string> = {};
    // Instead of matchNode which checks handlers existence, we need to find node regardless of method
    // Do a traversal that finds the terminal node for path, ignoring method, then return its handler keys
    const node = this.findNodeForPath(this.root, segments, 0, params);
    if (!node) return [];
    return [...node.handlers.keys()];
  }

  private findNodeForPath(
    node: Node,
    segments: string[],
    idx: number,
    params: Record<string, string>,
  ): Node | null {
    if (idx === segments.length) {
      if (node.handlers.size > 0) return node;
      if (node.wildcardChild && node.wildcardChild.handlers.size > 0) {
        params["wildcard"] = "";
        return node.wildcardChild;
      }
      return null;
    }
    const seg = segments[idx] as string;
    // static first
    const staticChild = node.children.get(seg);
    if (staticChild) {
      const found = this.findNodeForPath(staticChild, segments, idx + 1, params);
      if (found) return found;
    }
    if (node.paramChild) {
      // Fast path: skip decodeURIComponent when no `%` (bench/common case).
      // decodeURIComponent is expensive; most segments are plain ASCII.
      let decoded: string;
      try {
        decoded = seg.indexOf("%") === -1 ? seg : decodeURIComponent(seg);
      } catch {
        return null;
      }
      const prev = params[node.paramChild.paramName as string];
      params[node.paramChild.paramName as string] = decoded;
      const found = this.findNodeForPath(node.paramChild, segments, idx + 1, params);
      if (found) return found;
      if (prev === undefined) delete params[node.paramChild.paramName as string];
      else params[node.paramChild.paramName as string] = prev;
    }
    if (node.wildcardChild) {
      try {
        params["wildcard"] = Router.decodeRemainder(segments, idx);
      } catch {
        return null;
      }
      if (node.wildcardChild.handlers.size > 0) return node.wildcardChild;
    }
    return null;
  }

  /**
   * Decode wildcard remainder without per-segment map when possible.
   * Scans for `%` first (no string building); the engine-optimized `join`
   * then runs exactly once. Skips decode entirely in the common no-`%` case
   * (e.g. bench `/files/a/b/c`). Segment count is bounded upstream by the
   * 2048-char / 128-slash caps in `Mino.fetch`, so `slice` stays small.
   */
  private static decodeRemainder(segments: string[], idx: number): string {
    let encoded = false;
    for (let i = idx; i < segments.length; i++) {
      if ((segments[i] as string).indexOf("%") !== -1) {
        encoded = true;
        break;
      }
    }
    const tail = idx === 0 ? segments : segments.slice(idx);
    if (!encoded) return tail.join("/");
    return tail.map((s) => decodeURIComponent(s)).join("/");
  }

  private matchNode(
    node: Node,
    segments: string[],
    idx: number,
    params: Record<string, string>,
  ): Node | null {
    if (idx === segments.length) {
      // Exact match — return node if it has handlers
      if (node.handlers.size > 0) return node;
      // Also consider wildcard that matches empty remainder (e.g. /files/* on /files)
      if (node.wildcardChild && node.wildcardChild.handlers.size > 0) {
        params["wildcard"] = "";
        return node.wildcardChild;
      }
      return null;
    }

    const seg = segments[idx] as string;

    // 1. Static child first (highest priority)
    const staticChild = node.children.get(seg);
    if (staticChild) {
      const found = this.matchNode(staticChild, segments, idx + 1, params);
      if (found) return found;
    }

    // 2. Param child
    if (node.paramChild) {
      let decoded: string;
      try {
        decoded = seg.indexOf("%") === -1 ? seg : decodeURIComponent(seg);
      } catch {
        throw new BadRequestError("Invalid URL encoding");
      }
      const prev = params[node.paramChild.paramName as string];
      params[node.paramChild.paramName as string] = decoded;
      const found = this.matchNode(node.paramChild, segments, idx + 1, params);
      if (found) return found;
      // backtrack
      if (prev === undefined) delete params[node.paramChild.paramName as string];
      else params[node.paramChild.paramName as string] = prev;
    }

    // 3. Wildcard — consumes remainder
    if (node.wildcardChild) {
      let remainder: string;
      try {
        remainder = Router.decodeRemainder(segments, idx);
      } catch {
        throw new BadRequestError("Invalid URL encoding");
      }
      params["wildcard"] = remainder;
      if (node.wildcardChild.handlers.size > 0) return node.wildcardChild;
      // Wildcard nodes are leaves; no deeper traversal needed
    }

    return null;
  }

  // Instance-aware split respecting strict flag
  splitPath(path: string): string[] {
    let p = path;
    if (!p.startsWith("/")) p = `/${p}`;
    const q = p.indexOf("?");
    if (q !== -1) p = p.slice(0, q);
    const hash = p.indexOf("#");
    if (hash !== -1) p = p.slice(0, hash);
    if (!this.strict) {
      if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    } else {
      // strict: "/foo" vs "/foo/" are distinct; keep trailing slash as empty segment distinction
      // For "/foo/", we keep the trailing empty segment by not stripping, but split will produce ["foo",""]
      // For matching, we need to preserve that distinction; so we don't strip.
    }
    if (p === "/") return [];
    const stripped = p.startsWith("/") ? p.slice(1) : p;
    // In strict mode, preserve empty trailing segment for "/foo/" -> ["foo",""]
    // In non-strict, trailing slash already stripped, so no empty.
    return stripped.split("/");
  }

  static splitPath(path: string): string[] {
    // Static helper defaults to non-strict for backwards compat
    const r = new Router({ strict: false });
    return r.splitPath(path);
  }
}
