import { describe, it, expect } from "vitest";
import { m } from "@minostack/schema";
import {
  defineConfig,
  loadConfig,
  fromEnv,
  fromObject,
  redactConfig,
  formatConfigError,
  ConfigError,
} from "../src/index.js";

const ServerSchema = m.object({
  port: m.number().int(),
  host: m.string(),
  dbUrl: m.string(),
});

describe("@minostack/config", () => {
  it("loads and freezes merged layers (later wins)", () => {
    const def = defineConfig<{ port: number; host: string; dbUrl: string }>(ServerSchema, {
      name: "server",
    });
    const cfg = loadConfig(def, [
      fromObject({ port: 3000, host: "localhost", dbUrl: "postgres://db/app" }),
      fromObject({ port: 4000 }),
    ]);
    expect(cfg.port).toBe(4000);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(() => {
      (cfg as Record<string, unknown>).port = 1;
    }).toThrow();
  });

  it("maps env vars under a prefix", () => {
    const layer = fromEnv("APP_", {
      APP_PORT: "8080",
      APP_HOST: "example.com",
      OTHER: "ignored",
      APP_: "empty-ignored",
    });
    expect(layer).toMatchObject({ port: "8080", host: "example.com" });
    expect(layer).not.toHaveProperty("OTHER");
  });

  it("fails fast with an actionable message", () => {
    const def = defineConfig(ServerSchema, { name: "server" });
    let err: unknown;
    try {
      loadConfig(def, [fromObject({ port: "not-a-number", host: "h" })]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as ConfigError).message;
    expect(msg).toContain('Invalid config "server"');
    expect(msg).not.toContain("not-a-number");
  });

  it("works with ~standard schemas and parse-only schemas", () => {
    const def = defineConfig(ServerSchema);
    const cfg = loadConfig(def, [fromObject({ port: 1, host: "h", dbUrl: "u" })]);
    expect(cfg).toMatchObject({ port: 1 });
    const parseOnly = { parse: (v: unknown) => v as { a: number } };
    expect(loadConfig(defineConfig(parseOnly), [fromObject({ a: 1 })])).toEqual({ a: 1 });
    expect(() => loadConfig(defineConfig({}), [fromObject({})])).toThrow(ConfigError);
  });

  it("redacts secrets and truncates long strings", () => {
    const def = defineConfig<Record<string, unknown>>(ServerSchema, {
      secrets: ["dbUrl"],
    });
    const redacted = redactConfig(def, {
      port: 3000,
      host: "h",
      dbUrl: "postgres://user:s3cret@db/app",
      apiToken: "tok-123",
      blob: "x".repeat(500),
      nested: { password: "pw" },
    });
    expect(redacted.dbUrl).toBe("***");
    expect(redacted.apiToken).toBe("***");
    expect((redacted.nested as Record<string, unknown>).password).toBe("***");
    expect((redacted.blob as string).length).toBeLessThan(500);
    expect(redacted.port).toBe(3000);
  });

  it("formatConfigError caps lines", () => {
    const msg = formatConfigError(
      defineConfig(ServerSchema, { name: "s" }),
      Array.from({ length: 30 }, (_, i) => ({ path: [`f${i}`], message: "bad" })),
    );
    expect(msg).toContain("30 issues");
    expect(msg.split("\n").length).toBeLessThanOrEqual(12);
  });
});

describe("@minostack/config coverage", () => {
  it("supports safeParse-style schemas", () => {
    const schema = {
      safeParse: (v: unknown) =>
        typeof (v as { n?: unknown }).n === "number"
          ? { success: true as const, data: v }
          : {
              success: false as const,
              error: { issues: [{ path: ["n"], message: "need number" }] },
            },
    };
    const def = defineConfig<{ n: number }>(schema, { name: "sp" });
    expect(loadConfig(def, [fromObject({ n: 1 })])).toEqual({ n: 1 });
    expect(() => loadConfig(def, [fromObject({ n: "x" })])).toThrow(/need number/);
  });

  it("wraps parse throws and rejects invalid schemas", () => {
    const throwing = {
      parse: () => {
        throw new Error("nope");
      },
    };
    expect(() => loadConfig(defineConfig(throwing), [fromObject({})])).toThrow(/Invalid config/);
    const withIssues = {
      parse: () => {
        throw Object.assign(new Error("bad"), { issues: [{ path: ["a"], message: "bad a" }] });
      },
    };
    expect(() => loadConfig(defineConfig(withIssues), [fromObject({})])).toThrow(/bad a/);
    expect(() => loadConfig(defineConfig({}), [fromObject({})])).toThrow(/missing ~standard/);
  });

  it("redacts arrays and nested secret-like keys", () => {
    const def = defineConfig<Record<string, unknown>>(m.object({}), { name: "r" });
    const out = redactConfig(def, { tokens: ["a", "b"], list: [{ apiKey: "k" }] });
    expect(out).toEqual({ tokens: "***", list: [{ apiKey: "***" }] });
  });
});

describe("@minostack/config branch coverage", () => {
  it("covers schema-fallback and message-formatting arms", () => {
    const noIssues = { "~standard": { validate: () => ({ issues: [] as readonly unknown[] }) } };
    expect(() => loadConfig(defineConfig(noIssues), [fromObject({})])).toThrow(/0 issues/);
    const spNoError = { safeParse: () => ({ success: false as const }) };
    expect(() => loadConfig(defineConfig(spNoError), [fromObject({})])).toThrow(/0 issues/);
    const strThrow = {
      parse: () => {
        throw "string-fail";
      },
    };
    expect(() => loadConfig(defineConfig(strThrow), [fromObject({})])).toThrow(/Validation failed/);
    const layer = fromEnv("APP_", { APP_A: undefined, SKIP: "x", APP_MULTI_WORD_KEY: "v" });
    expect(layer).toMatchObject({ multiWordKey: "v" });
    expect(layer).not.toHaveProperty("a");
    const msg = formatConfigError(defineConfig(m.object({}), { name: "n" }), [
      { message: 42 },
      "plain",
    ]);
    expect(msg).toContain("invalid value");
    const frozen = Object.freeze({ a: Object.freeze({ b: 1 }) });
    const def = defineConfig<{ a: { b: number } }>({
      parse: (v: unknown) => v as { a: { b: number } },
    });
    expect(loadConfig(def, [fromObject({ a: frozen.a })])).toBeDefined();
  });
});
