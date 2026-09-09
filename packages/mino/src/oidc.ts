/**
 * `@minostack/mino/oidc` — runtime-agnostic OIDC/OAuth2 login boundary (plan P1.2).
 *
 * Zero dependencies, no vendor SDK. Covers three flows in dev-mode preview:
 * authorization-code (+PKCE), client credentials, and device authorization.
 * All network I/O goes through an injectable `fetchFn` so tests use a fake
 * provider; failures surface as catalog errors without leaking secrets.
 *
 * ```ts
 * import { authorizationUrl, createPkcePair } from "@minostack/mino/oidc";
 *
 * const pkce = await createPkcePair();
 * const url = authorizationUrl({
 *   issuer: "https://id.example.com",
 *   clientId: "web",
 *   redirectUri: "https://app.example.com/cb",
 *   state, nonce: "...", pkceChallenge: pkce.challenge,
 * });
 * ```
 */

import { BadRequestError, ForbiddenError, InvalidTokenError } from "./errors.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Random URL-safe string via WebCrypto. */
function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64Url(buf);
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64Url(new Uint8Array(digest));
}

// ─────────────────────────────────────────────────────────────────
// PKCE + authorization URL
// ─────────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** Generate a PKCE pair (S256). Verifier is high-entropy; only the challenge leaves the client. */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = randomToken(32);
  return { verifier, challenge: await sha256Base64Url(verifier), method: "S256" };
}

export interface AuthorizationUrlOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state: string;
  nonce?: string;
  pkceChallenge?: string;
  extraParams?: Record<string, string>;
}

/** Build the authorization redirect URL. `state` is required (CSRF protection). */
export function authorizationUrl(opts: AuthorizationUrlOptions): string {
  if (!opts.state) throw new BadRequestError("state is required");
  const base = opts.issuer.replace(/\/+$/, "");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scope ?? "openid profile email",
    state: opts.state,
  });
  if (opts.nonce) q.set("nonce", opts.nonce);
  if (opts.pkceChallenge) {
    q.set("code_challenge", opts.pkceChallenge);
    q.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(opts.extraParams ?? {})) q.set(k, v);
  return `${base}/authorize?${q.toString()}`;
}

export interface CallbackResult {
  code: string;
  state: string;
}

/**
 * Validate the authorization callback query. Throws `BadRequestError` on
 * provider errors or state mismatch (never echoes secrets — there are none).
 */
export function validateCallback(
  params: { code?: string; state?: string; error?: string; error_description?: string },
  expectedState: string,
): CallbackResult {
  if (params.error) throw new ForbiddenError("Authorization denied by provider");
  if (!params.code || !params.state) throw new BadRequestError("Missing code or state");
  if (params.state !== expectedState) throw new BadRequestError("State mismatch");
  return { code: params.code, state: params.state };
}

// ─────────────────────────────────────────────────────────────────
// Token endpoint helpers (code exchange + client credentials)
// ─────────────────────────────────────────────────────────────────

export interface TokenSet {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

async function postForm(
  endpoint: string,
  body: Record<string, string>,
  fetchFn: FetchFn,
  authHeader?: string,
): Promise<TokenSet> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (authHeader) headers.authorization = authHeader;
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new InvalidTokenError("Token endpoint rejected the request");
  return (await res.json()) as TokenSet;
}

export interface CodeExchangeOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  fetchFn?: FetchFn;
}

/** Exchange an authorization code for tokens. Secret travels only server-side. */
export async function exchangeCode(opts: CodeExchangeOptions): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
  };
  if (opts.codeVerifier) body.code_verifier = opts.codeVerifier;
  const auth =
    opts.clientSecret !== undefined
      ? `Basic ${btoa(`${opts.clientId}:${opts.clientSecret}`)}`
      : undefined;
  return postForm(opts.tokenEndpoint, body, opts.fetchFn ?? fetch, auth);
}

export interface ClientCredentialsOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  fetchFn?: FetchFn;
}

/** Machine-to-machine token request. */
export async function clientCredentials(opts: ClientCredentialsOptions): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: "client_credentials",
    scope: opts.scope ?? "",
  };
  return postForm(
    opts.tokenEndpoint,
    body,
    opts.fetchFn ?? fetch,
    `Basic ${btoa(`${opts.clientId}:${opts.clientSecret}`)}`,
  );
}

// ─────────────────────────────────────────────────────────────────
// JWKS cache (rotation-safe by TTL refresh)
// ─────────────────────────────────────────────────────────────────

export interface JwksCacheOptions {
  ttlMs?: number;
  fetchFn?: FetchFn;
  now?: () => number;
}

/** Minimal JWKS cache: refreshes after `ttlMs` so rotated keys are picked up. */
export class MemoryJwksCache {
  private cached: { at: number; jwks: unknown } | undefined;
  private readonly ttlMs: number;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;

  constructor(opts: JwksCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async getJwks(jwksUri: string): Promise<unknown> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.jwks;
    const res = await this.fetchFn(jwksUri);
    if (!res.ok) throw new InvalidTokenError("JWKS fetch failed");
    const jwks = (await res.json()) as unknown;
    this.cached = { at: this.now(), jwks };
    return jwks;
  }

  clear(): void {
    this.cached = undefined;
  }
}

// ─────────────────────────────────────────────────────────────────
// Device authorization flow (RFC 8628, dev-mode preview)
// ─────────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  /** Poll interval seconds requested by the provider */
  interval: number;
}

export interface DeviceRequestOptions {
  deviceEndpoint: string;
  clientId: string;
  scope?: string;
  fetchFn?: FetchFn;
}

/** Start a device flow — returns codes for the user-facing verification step. */
export async function requestDeviceCode(opts: DeviceRequestOptions): Promise<DeviceCodeResponse> {
  const res = await (opts.fetchFn ?? fetch)(opts.deviceEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      scope: opts.scope ?? "",
    }).toString(),
  });
  if (!res.ok) throw new BadRequestError("Device authorization rejected");
  return (await res.json()) as DeviceCodeResponse;
}

export interface DevicePollOptions {
  tokenEndpoint: string;
  clientId: string;
  deviceCode: string;
  /** Provider-requested interval (seconds); `slow_down` adds 5s per signal */
  intervalSec?: number;
  /** Overall budget in ms (default 5 min) */
  timeoutMs?: number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll the token endpoint until the user approves/denies or budgets expire.
 * `authorization_pending` waits `intervalSec`; `slow_down` extends the
 * interval by 5s; `expired_token`/`access_denied` throw catalog errors.
 * `sleep`/`now` are injectable for deterministic tests.
 */
export async function pollDeviceToken(opts: DevicePollOptions): Promise<TokenSet> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.timeoutMs ?? 5 * 60 * 1000);
  let intervalMs = (opts.intervalSec ?? 5) * 1000;

  for (;;) {
    if (now() >= deadline) throw new InvalidTokenError("Device flow timed out");
    const res = await fetchFn(opts.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: opts.deviceCode,
        client_id: opts.clientId,
      }).toString(),
    });
    if (res.ok) return (await res.json()) as TokenSet;
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    if (err.error === "authorization_pending") {
      await sleep(intervalMs);
      continue;
    }
    if (err.error === "slow_down") {
      intervalMs += 5000;
      await sleep(intervalMs);
      continue;
    }
    if (err.error === "expired_token") throw new InvalidTokenError("Device code expired");
    if (err.error === "access_denied") throw new ForbiddenError("Device flow denied by user");
    throw new InvalidTokenError("Device token poll failed");
  }
}
