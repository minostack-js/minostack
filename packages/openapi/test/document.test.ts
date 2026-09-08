import { assert, describe, it } from "vitest";
import { m } from "@minostack/schema";
import type { Schema } from "@minostack/schema";
import { document30, document31, oas31 } from "../src/index.js";

describe("document", () => {
  it("builds components with $refs for shared subschemas", () => {
    const address = m.object({ city: m.string() });
    const result = document31(
      { title: "API", version: "1.0.0" },
      {
        User: m.object({ name: m.string(), home: address }),
        Company: m.object({ hq: address }),
        Address: address,
      },
    );
    assert.deepEqual(result.document, {
      openapi: "3.1.0",
      info: { title: "API", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          User: {
            type: "object",
            properties: {
              name: { type: "string" },
              home: { $ref: "#/components/schemas/Address" },
            },
            required: ["name", "home"],
          },
          Company: {
            type: "object",
            properties: { hq: { $ref: "#/components/schemas/Address" } },
            required: ["hq"],
          },
          Address: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    });
    assert.deepEqual(result.warnings, []);
  });

  it("maps discriminators to registered components", () => {
    const success = m.object({ type: m.literal("success"), value: m.string() });
    const failure = m.object({ type: m.literal("error") });
    const result = document31(
      { title: "API", version: "1.0.0" },
      {
        Success: success,
        Error: failure,
        Result: m.discriminatedUnion("type", { success, error: failure }),
      },
    );
    const resultSchema = result.document.components.schemas["Result"];
    assert.deepEqual(resultSchema, {
      oneOf: [{ $ref: "#/components/schemas/Success" }, { $ref: "#/components/schemas/Error" }],
      discriminator: {
        propertyName: "type",
        mapping: {
          success: "#/components/schemas/Success",
          error: "#/components/schemas/Error",
        },
      },
    });
  });

  it("resolves recursion through $refs", () => {
    type Category = { name: string; subs: Category[] };
    const category: Schema<Category> = m.object({
      name: m.string(),
      subs: m.array(m.lazy<Category>(() => category)),
    });
    const result = document31({ title: "API", version: "1.0.0" }, { Category: category });
    assert.deepEqual(result.document.components.schemas["Category"], {
      type: "object",
      properties: {
        name: { type: "string" },
        subs: { type: "array", items: { $ref: "#/components/schemas/Category" } },
      },
      required: ["name", "subs"],
    });
  });

  it("throws for standalone recursive conversion", () => {
    type Category = { name: string; subs: Category[] };
    const category: Schema<Category> = m.object({
      name: m.string(),
      subs: m.array(m.lazy<Category>(() => category)),
    });
    assert.throws(() => oas31(category), /document31/);
  });

  it("prefixes warnings with component names", () => {
    const result = document31(
      { title: "API", version: "1.0.0" },
      {
        Shaped: m.object({ value: m.string().transform((value) => value.length) }),
      },
    );
    assert.deepEqual(
      result.warnings.map((warning) => [warning.code, warning.path]),
      [["transform-input-side", ["Shaped", "value"]]],
    );
  });

  it("builds 3.0 documents", () => {
    const result = document30(
      { title: "API", version: "2.0.0", description: "Legacy" },
      {
        Name: m.string().nullable(),
      },
    );
    assert.deepEqual(result.document, {
      openapi: "3.0.3",
      info: { title: "API", version: "2.0.0", description: "Legacy" },
      paths: {},
      components: { schemas: { Name: { type: "string", nullable: true } } },
    });
  });
});
