import { describe, it, expect } from "vitest";
import {
  parseTraceparent,
  formatTraceparent,
  resolveTraceContext,
  createTraceContext,
} from "../src/observability.js";
import { Container } from "../src/container.js";

describe("kernel traceparent propagation (P3.5)", () => {
  const header = "00-4bf92f3577b34da6a3ce929d0e0e4731-00f067aa0ba902b7-01";

  it("parses valid headers and rejects malformed/all-zero", () => {
    expect(parseTraceparent(header)).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4731",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent("bogus")).toBeUndefined();
    expect(
      parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    ).toBeUndefined();
    expect(
      parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4731-0000000000000000-01"),
    ).toBeUndefined();
  });

  it("round-trips through format", () => {
    const ctx = parseTraceparent(header) as {
      traceId: string;
      spanId: string;
      traceFlags?: number;
    };
    expect(formatTraceparent(ctx)).toBe(header);
  });

  it("continues incoming traces, starts fresh ones otherwise", () => {
    const continued = resolveTraceContext(header);
    expect(continued.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4731");
    const fresh = resolveTraceContext(null);
    expect(fresh.traceId).not.toBe(continued.traceId);
    expect(createTraceContext().traceFlags).toBe(1);
  });
});

describe("kernel request-scope disposal (P6.2)", () => {
  it("destroys request-scoped instances in reverse order, keeps singletons", async () => {
    const destroyed: string[] = [];
    class ReqA {
      async onDestroy(): Promise<void> {
        destroyed.push("a");
      }
    }
    class ReqB {
      async onDestroy(): Promise<void> {
        destroyed.push("b");
      }
    }
    class Sing {
      value = 1;
    }
    const root = new Container();
    root.register({ token: Sing, useClass: Sing, scope: "singleton" });
    root.register({ token: ReqA, useClass: ReqA, scope: "request" });
    root.register({ token: ReqB, useClass: ReqB, scope: "request" });
    const child = root.createRequestScope();
    await child.get(ReqA);
    await child.get(ReqB);
    const sing = await root.get(Sing);
    await child.destroyRequestScope();
    expect(destroyed).toEqual(["b", "a"]);
    expect(await root.get(Sing)).toBe(sing);
    // Second destroy is a safe no-op
    await child.destroyRequestScope();
    expect(destroyed).toEqual(["b", "a"]);
  });
});
