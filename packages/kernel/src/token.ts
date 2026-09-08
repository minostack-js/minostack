/**
 * Token — opaque identifier for DI.
 * Supports string, symbol, class constructor, or branded token via createToken.
 */

export type Token<T = unknown> = string | symbol | (new (...args: unknown[]) => T) | TokenBrand<T>;

export interface TokenBrand<T> {
  readonly __brand: T;
  readonly description: string;
  toString(): string;
}

const TOKEN_REGISTRY = new Map<string, TokenBrand<unknown>[]>();

export function createToken<T>(description: string): TokenBrand<T> {
  const key = `Token(${description})`;
  const brand: TokenBrand<T> = {
    description,
    __brand: undefined as unknown as T,
    toString() {
      return key;
    },
  };
  // Keep for debugging — group by description to avoid unbounded random keys, still allow same description distinct tokens
  const list = TOKEN_REGISTRY.get(description) ?? [];
  list.push(brand as unknown as TokenBrand<unknown>);
  TOKEN_REGISTRY.set(description, list);
  return brand;
}

export function getTokenName(token: Token): string {
  if (typeof token === "string") return token;
  if (typeof token === "symbol") return token.description ?? token.toString();
  if (typeof token === "function") return (token as { name?: string }).name ?? "AnonymousClass";
  if (typeof token === "object" && token !== null && "description" in token) {
    return (token as TokenBrand<unknown>).description;
  }
  return String(token);
}

/** Helper to check if token is a class constructor */
export function isClassToken(token: Token): boolean {
  return typeof token === "function" && !!token.prototype;
}
