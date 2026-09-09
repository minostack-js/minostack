import { describe, it, expect } from "vitest";

/**
 * api-freeze: pins the public export surface of every `@minostack/mino/*`
 * sub-path (plan H1 — API freeze for 1.0.0-alpha.0).
 *
 * Adding a new export is a deliberate API change: update this list AND the
 * changeset AND the README sub-path docs in the same commit. Removing or
 * renaming an export is breaking and requires a major bump note.
 */
const CASES: Array<{ name: string; mod: string; exports: string[] }> = [
  { name: "helmet", mod: "../src/helmet.js", exports: ["helmet"] },
  { name: "cors", mod: "../src/cors.js", exports: ["cors"] },
  { name: "rate-limit", mod: "../src/rate-limit.js", exports: ["clientIp", "rateLimit"] },
  { name: "timeout", mod: "../src/timeout.js", exports: ["timeout"] },
  {
    name: "request-id",
    mod: "../src/request-id.js",
    exports: ["REQUEST_ID_STATE_KEY", "logger", "requestId"],
  },
  {
    name: "cookie",
    mod: "../src/cookie.js",
    exports: [
      "MAX_COOKIES",
      "MAX_COOKIE_VALUE_CHARS",
      "appendSetCookie",
      "createCookieSigner",
      "getCookie",
      "getSetCookies",
      "parseCookie",
      "serializeCookie",
      "setCookie",
      "signCookie",
      "unsignCookie",
    ],
  },
  {
    name: "jwt",
    mod: "../src/jwt.js",
    exports: [
      "ForbiddenError",
      "JWT_PAYLOAD_KEY",
      "TOKEN_PAYLOAD_KEY",
      "decode",
      "jwt",
      "sign",
      "token",
      "verify",
    ],
  },
  {
    name: "csrf",
    mod: "../src/csrf.js",
    exports: ["csrf", "csrfWithStore", "generateCsrfToken", "safeEqual"],
  },
  {
    name: "session",
    mod: "../src/session.js",
    exports: [
      "MemoryStore",
      "RotatingTokenStore",
      "SESSION_ID_KEY",
      "SESSION_KEY",
      "generateSessionId",
      "regenerateSessionId",
      "session",
    ],
  },
  { name: "compress", mod: "../src/compress.js", exports: ["compress"] },
  { name: "etag", mod: "../src/etag.js", exports: ["conditional", "etag", "generateETag"] },
  { name: "static", mod: "../src/static.js", exports: ["normalizeStaticPath", "serveStatic"] },
  {
    name: "paseto",
    mod: "../src/paseto.js",
    exports: [
      "PASETO_PAYLOAD_KEY",
      "base64UrlToBytes",
      "blake2b",
      "bytesToBase64Url",
      "decrypt",
      "encrypt",
      "generateLocalKey",
      "generatePublicKeypair",
      "pae",
      "paseto",
      "sign",
      "verify",
      "xchacha20",
    ],
  },
  {
    name: "basic-auth",
    mod: "../src/basic-auth.js",
    exports: ["BASIC_USER_KEY", "basic", "safeEqualBasic"],
  },
  {
    name: "bearer-auth",
    mod: "../src/bearer-auth.js",
    exports: ["BEARER_KEY", "BEARER_PAYLOAD_KEY", "bearer"],
  },
  { name: "method-override", mod: "../src/method-override.js", exports: ["withMethodOverride"] },
  { name: "trailing-slash", mod: "../src/trailing-slash.js", exports: ["trailingSlash"] },
  { name: "trim-path", mod: "../src/trim-path.js", exports: ["trimPath"] },
  { name: "vhost", mod: "../src/vhost.js", exports: ["vhost"] },
  { name: "response-time", mod: "../src/response-time.js", exports: ["responseTime"] },
  { name: "powered-by", mod: "../src/powered-by.js", exports: ["poweredBy"] },
  { name: "ip-restriction", mod: "../src/ip-restriction.js", exports: ["ipRestrict"] },
  { name: "formbody", mod: "../src/formbody.js", exports: ["formbody"] },
  { name: "cache", mod: "../src/cache.js", exports: ["cache"] },
  {
    name: "proxy",
    mod: "../src/proxy.js",
    exports: ["combine", "isTargetAllowed", "proxy"],
  },
  {
    name: "under-pressure",
    mod: "../src/under-pressure.js",
    exports: ["createPressureMonitor", "underPressure"],
  },
  {
    name: "websocket",
    mod: "../src/websocket.js",
    exports: [
      "Opcode",
      "WEBSOCKET_GUID",
      "createAcceptKey",
      "createFrameParser",
      "encodeFrame",
      "isWebSocketRequest",
      "websocketUpgradeResponse",
    ],
  },
  {
    name: "file",
    mod: "../src/file.js",
    exports: [
      "contentDisposition",
      "contentTypeForExt",
      "formatContentRange",
      "parseRange",
      "parseRangeList",
    ],
  },
  { name: "logger", mod: "../src/logger.js", exports: ["logger"] },
  {
    name: "multipart",
    mod: "../src/multipart.js",
    exports: ["collectPart", "parseMultipart", "partText"],
  },
  {
    name: "envelope",
    mod: "../src/envelope.js",
    exports: ["cursorPage", "fail", "ok", "page"],
  },
  {
    name: "principal",
    mod: "../src/principal.js",
    exports: [
      "MemoryAuditSink",
      "PRINCIPAL_KEY",
      "attachPrincipal",
      "audit",
      "createAuditEvent",
      "getPrincipal",
      "getRequestPrincipal",
      "requireAuth",
      "requirePermission",
      "requireRole",
      "requireTenant",
      "setPrincipal",
    ],
  },
  {
    name: "oidc",
    mod: "../src/oidc.js",
    exports: [
      "MemoryJwksCache",
      "authorizationUrl",
      "clientCredentials",
      "createPkcePair",
      "exchangeCode",
      "pollDeviceToken",
      "requestDeviceCode",
      "validateCallback",
    ],
  },
  { name: "retry", mod: "../src/retry.js", exports: ["isRetryableStatus", "withRetry"] },
  {
    name: "circuit-breaker",
    mod: "../src/circuit-breaker.js",
    exports: ["CircuitBreaker", "CircuitOpenError"],
  },
  { name: "bulkhead", mod: "../src/bulkhead.js", exports: ["Bulkhead", "bulkhead"] },
  {
    name: "idempotency",
    mod: "../src/idempotency.js",
    exports: ["MemoryIdempotencyStore", "idempotency"],
  },
  {
    name: "health",
    mod: "../src/health.js",
    exports: ["createReadinessMonitor", "live", "ready"],
  },
  {
    name: "versioning",
    mod: "../src/versioning.js",
    exports: ["sunset", "versionPrefix", "versioned"],
  },
];

describe("api-freeze: sub-path export surface", () => {
  for (const c of CASES) {
    it(`${c.name} exports exactly [${c.exports.join(", ")}]`, async () => {
      const ns = (await import(c.mod)) as Record<string, unknown>;
      expect(Object.keys(ns).sort()).toEqual([...c.exports].sort());
    });
  }

  it("core index exposes validatorAsync alongside validator", async () => {
    const core = (await import("../src/index.js")) as Record<string, unknown>;
    for (const name of ["Mino", "validator", "validatorAsync", "dto", "compose", "Router"]) {
      expect(core[name], `core missing export: ${name}`).toBeDefined();
    }
  });
});
