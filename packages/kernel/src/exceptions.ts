/**
 * Kernel exception system — deterministic, with HTTP mapping.
 * Re-uses HttpError concepts from @minostack/mino but provides kernel-specific hierarchy.
 */

export class HttpException extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message?: string, opts: { code?: string } = {}) {
    super(message ?? `Http Exception ${status}`);
    this.name = this.constructor.name;
    this.status = status;
    this.code = opts.code;
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({ error: this.message, status: this.status, code: this.code }),
      {
        status: this.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
}

export class BadRequestException extends HttpException {
  constructor(message = "Bad Request", code = "bad_request") {
    super(400, message, { code });
  }
}
export class UnauthorizedException extends HttpException {
  constructor(message = "Unauthorized", code = "unauthorized") {
    super(401, message, { code });
  }
}
export class ForbiddenException extends HttpException {
  constructor(message = "Forbidden", code = "forbidden") {
    super(403, message, { code });
  }
}
export class NotFoundException extends HttpException {
  constructor(message = "Not Found", code = "not_found") {
    super(404, message, { code });
  }
}
export class ConflictException extends HttpException {
  constructor(message = "Conflict", code = "conflict") {
    super(409, message, { code });
  }
}
export class InternalServerErrorException extends HttpException {
  constructor(message = "Internal Server Error", code = "internal") {
    super(500, message, { code });
  }
}

/** Exception filter signature — maps exception to Response */
export type ExceptionFilter = (
  exception: unknown,
  ctx: { request: Request },
) => Response | Promise<Response>;

export const defaultExceptionFilter: ExceptionFilter = (exception) => {
  if (exception instanceof HttpException) return exception.toResponse();
  // Also handle Mino's HttpError which has .status and toResponse() but different hierarchy (duck-type)
  if (
    exception !== null &&
    typeof exception === "object" &&
    "status" in exception &&
    typeof (exception as { status: unknown }).status === "number" &&
    typeof (exception as { toResponse?: unknown }).toResponse === "function"
  ) {
    try {
      return (exception as unknown as { toResponse: () => Response }).toResponse();
    } catch {
      // fall through
    }
  }
  if (
    exception !== null &&
    typeof exception === "object" &&
    "status" in exception &&
    typeof (exception as { status: unknown }).status === "number"
  ) {
    const status = (exception as { status: number }).status;
    const message = (exception as { message?: string }).message ?? `Http Exception ${status}`;
    const code = (exception as { code?: string }).code;
    return new Response(JSON.stringify({ error: message, status, ...(code ? { code } : {}) }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (exception instanceof Error) {
    // Don't leak internal messages for 500
    return new Response(JSON.stringify({ error: "Internal Server Error", status: 500 }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response("Internal Server Error", { status: 500 });
};
