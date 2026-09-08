/**
 * HTTP Error hierarchy for Mino.
 * Keeps error handling deterministic and machine-readable.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly expose: boolean;
  /** Optional machine-readable code */
  readonly code?: string;

  constructor(status: number, message?: string, opts: { expose?: boolean; code?: string } = {}) {
    super(message ?? HttpError.statusText(status));
    this.name = "HttpError";
    this.status = status;
    this.expose = opts.expose ?? status < 500;
    this.code = opts.code;
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
      413: "Payload Too Large",
      415: "Unsupported Media Type",
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
    return new Response(body, {
      status: this.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
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
