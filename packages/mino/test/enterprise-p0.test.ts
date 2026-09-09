import { describe, it, expect } from "vitest";
import { Mino } from "../src/index.js";
import {
  HttpError,
  MissingCredentialsError,
  InvalidTokenError,
  ExpiredTokenError,
  MissingRoleError,
  MissingPermissionError,
  TenantForbiddenError,
  ConflictError,
  PreconditionFailedError,
  UriTooLongError,
  TooManyRequestsError,
  BadGatewayError,
  ServiceUnavailableError,
  NotReadyError,
} from "../src/index.js";
import { ok, fail, page, cursorPage } from "../src/envelope.js";

describe("P0: enterprise error catalog", () => {
  const cases: Array<{
    ctor: new (message?: string, retryAfterSec?: number) => HttpError;
    status: number;
    code: string;
    exposesCode: boolean;
  }> = [
    { ctor: MissingCredentialsError, status: 401, code: "missing_credentials", exposesCode: true },
    { ctor: InvalidTokenError, status: 401, code: "invalid_token", exposesCode: true },
    { ctor: ExpiredTokenError, status: 401, code: "token_expired", exposesCode: true },
    { ctor: MissingRoleError, status: 403, code: "missing_role", exposesCode: true },
    { ctor: MissingPermissionError, status: 403, code: "missing_permission", exposesCode: true },
    { ctor: TenantForbiddenError, status: 403, code: "tenant_forbidden", exposesCode: true },
    { ctor: ConflictError, status: 409, code: "conflict", exposesCode: true },
    { ctor: PreconditionFailedError, status: 412, code: "precondition_failed", exposesCode: true },
    { ctor: UriTooLongError, status: 414, code: "uri_too_long", exposesCode: true },
    { ctor: TooManyRequestsError, status: 429, code: "rate_limited", exposesCode: true },
    { ctor: BadGatewayError, status: 502, code: "bad_gateway", exposesCode: false },
    { ctor: ServiceUnavailableError, status: 503, code: "service_unavailable", exposesCode: false },
    { ctor: NotReadyError, status: 503, code: "not_ready", exposesCode: true },
  ];
  for (const { ctor: Ctor, status, code, exposesCode } of cases) {
    it(`${String((Ctor as unknown as { name: string }).name)} → ${status} ${code}`, async () => {
      const err = new Ctor("custom-internal-detail") as HttpError;
      expect(err.status).toBe(status);
      const res = err.toResponse();
      expect(res.status).toBe(status);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe(status);
      if (exposesCode) expect(body.code).toBe(code);
      else expect(body.code).toBeUndefined();
      // 5xx never leaks the custom message
      if (status >= 500 && !exposesCode) {
        expect(body.error).not.toContain("custom-internal-detail");
      }
    });
  }

  it("429/503 carry Retry-After when provided", async () => {
    const r429 = new TooManyRequestsError("slow down", 30).toResponse();
    expect(r429.headers.get("retry-after")).toBe("30");
    const r503 = new NotReadyError("warming up", 5).toResponse();
    expect(r503.headers.get("retry-after")).toBe("5");
    const plain = new TooManyRequestsError().toResponse();
    expect(plain.headers.get("retry-after")).toBeNull();
  });

  it("catalog errors flow through Mino.onError without leaking", async () => {
    const app = new Mino();
    app.get("/boom", () => {
      throw new ServiceUnavailableError("db socket fd=9 conn=secret");
    });
    const res = await app.fetch(new Request("http://localhost/boom"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Service Unavailable");
    expect(body).not.toHaveProperty("code");
  });
});

describe("P0: envelope conventions", () => {
  it("ok/fail build stable shapes", () => {
    expect(ok({ id: "1" })).toEqual({ ok: true, data: { id: "1" } });
    expect(ok([1], { requestId: "r1" }).meta?.requestId).toBe("r1");
    expect(fail("Nope", 404, "not_found")).toEqual({
      ok: false,
      error: "Nope",
      status: 404,
      code: "not_found",
    });
  });

  it("page derives totalPages", () => {
    expect(page([1, 2], { page: 1, perPage: 20, total: 95 }).totalPages).toBe(5);
    expect(page([], { page: 1, perPage: 0, total: 0 }).totalPages).toBe(0);
    expect(cursorPage([1], "abc")).toEqual({ ok: true, data: [1], nextCursor: "abc" });
    expect(cursorPage([], null).nextCursor).toBeNull();
  });

  it("envelopes work through handlers", async () => {
    const app = new Mino();
    app.get("/u", (c) => c.json(ok([{ id: "1" }])));
    const res = await app.fetch(new Request("http://localhost/u"));
    expect(await res.json()).toEqual({ ok: true, data: [{ id: "1" }] });
  });
});
