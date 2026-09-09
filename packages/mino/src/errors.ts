/**
 * HTTP Error hierarchy for Mino.
 * Keeps error handling deterministic and machine-readable.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly expose: boolean;
  /** Optional machine-readable code */
  readonly code?: string;
  /** Optional extra response headers (e.g. `Retry-After` on 429/503) */
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    message?: string,
    opts: { expose?: boolean; code?: string; headers?: Record<string, string> } = {},
  ) {
    super(message ?? HttpError.statusText(status));
    this.name = "HttpError";
    this.status = status;
    this.expose = opts.expose ?? status < 500;
    this.code = opts.code;
    this.headers = opts.headers;
  }

  static statusText(status: number): string {
    const map: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      405: "Method Not Allowed",
      408: "Request Timeout",
      409: "Conflict",
      412: "Precondition Failed",
      413: "Payload Too Large",
      414: "URI Too Long",
      415: "Unsupported Media Type",
      416: "Range Not Satisfiable",
      422: "Unprocessable Entity",
      429: "Too Many Requests",
      500: "Internal Server Error",
      501: "Not Implemented",
      502: "Bad Gateway",
      503: "Service Unavailable",
    };
    return map[status] ?? "Error";
  }

  toResponse(): Response {
    // Enterprise security: never leak internal 5xx messages unless explicitly exposed.
    const message = this.expose ? this.message : HttpError.statusText(this.status);
    const body = JSON.stringify({
      error: message,
      status: this.status,
      ...(this.code && this.expose ? { code: this.code } : {}),
    });
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    if (this.headers) Object.assign(headers, this.headers);
    return new Response(body, { status: this.status, headers });
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not Found") {
    super(404, message, { expose: true, code: "not_found" });
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad Request", code = "bad_request") {
    super(400, message, { expose: true, code });
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message, { expose: true, code: "unauthorized" });
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message, { expose: true, code: "forbidden" });
    this.name = "ForbiddenError";
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message = "Payload Too Large") {
    super(413, message, { expose: true, code: "payload_too_large" });
    this.name = "PayloadTooLargeError";
  }
}

// ─────────────────────────────────────────────────────────────────
// Enterprise catalog (plan P0.1) — stable { error, status, code } shapes
// for auth, conflict/state, resilience, and operations. All 4xx expose
// their code; 5xx stay generic unless explicitly exposed.
// ─────────────────────────────────────────────────────────────────

export class MissingCredentialsError extends HttpError {
  constructor(message = "Missing credentials") {
    super(401, message, { expose: true, code: "missing_credentials" });
    this.name = "MissingCredentialsError";
  }
}

export class InvalidTokenError extends HttpError {
  constructor(message = "Invalid token") {
    super(401, message, { expose: true, code: "invalid_token" });
    this.name = "InvalidTokenError";
  }
}

export class ExpiredTokenError extends HttpError {
  constructor(message = "Token expired") {
    super(401, message, { expose: true, code: "token_expired" });
    this.name = "ExpiredTokenError";
  }
}

export class MissingRoleError extends HttpError {
  constructor(message = "Missing required role") {
    super(403, message, { expose: true, code: "missing_role" });
    this.name = "MissingRoleError";
  }
}

export class MissingPermissionError extends HttpError {
  constructor(message = "Missing required permission") {
    super(403, message, { expose: true, code: "missing_permission" });
    this.name = "MissingPermissionError";
  }
}

export class TenantForbiddenError extends HttpError {
  constructor(message = "Tenant access denied") {
    super(403, message, { expose: true, code: "tenant_forbidden" });
    this.name = "TenantForbiddenError";
  }
}

export class ConflictError extends HttpError {
  constructor(message = "Conflict") {
    super(409, message, { expose: true, code: "conflict" });
    this.name = "ConflictError";
  }
}

export class PreconditionFailedError extends HttpError {
  constructor(message = "Precondition Failed") {
    super(412, message, { expose: true, code: "precondition_failed" });
    this.name = "PreconditionFailedError";
  }
}

export class UriTooLongError extends HttpError {
  constructor(message = "URI Too Long") {
    super(414, message, { expose: true, code: "uri_too_long" });
    this.name = "UriTooLongError";
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message = "Too Many Requests", retryAfterSec?: number) {
    super(429, message, {
      expose: true,
      code: "rate_limited",
      ...(retryAfterSec !== undefined ? { headers: { "retry-after": String(retryAfterSec) } } : {}),
    });
    this.name = "TooManyRequestsError";
  }
}

export class BadGatewayError extends HttpError {
  constructor(message = "Bad Gateway") {
    super(502, message, { expose: false, code: "bad_gateway" });
    this.name = "BadGatewayError";
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message = "Service Unavailable", retryAfterSec?: number) {
    super(503, message, {
      expose: false,
      code: "service_unavailable",
      ...(retryAfterSec !== undefined ? { headers: { "retry-after": String(retryAfterSec) } } : {}),
    });
    this.name = "ServiceUnavailableError";
  }
}

export class NotReadyError extends HttpError {
  constructor(message = "Service Not Ready", retryAfterSec?: number) {
    super(503, message, {
      expose: true,
      code: "not_ready",
      ...(retryAfterSec !== undefined ? { headers: { "retry-after": String(retryAfterSec) } } : {}),
    });
    this.name = "NotReadyError";
  }
}

export class ValidationError extends HttpError {
  readonly issues: readonly unknown[];
  constructor(message = "Validation Failed", issues: readonly unknown[] = []) {
    super(422, message, { expose: true, code: "validation_failed" });
    this.name = "ValidationError";
    this.issues = issues;
  }

  override toResponse(): Response {
    return new Response(
      JSON.stringify({
        error: this.message,
        status: this.status,
        code: this.code,
        issues: this.issues,
      }),
      { status: this.status, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }
}
