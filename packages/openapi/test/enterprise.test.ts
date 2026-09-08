import { assert, describe, it } from "vitest";
import { m } from "@minostack/schema";
import { document30, document31, oas31 } from "../src/index.js";

describe("enterprise: document with paths, components, webhooks, servers", () => {
  it("builds 3.1 document with full enterprise options and $ref deduplication", () => {
    const User = m.object({ id: m.string().uuid(), name: m.string().min(2) }).meta({ id: "User" });
    const ErrorResponse = m
      .object({ code: m.string(), message: m.string() })
      .meta({ id: "ErrorResponse" });
    const PaginatedUsers = m
      .object({ items: m.array(User).max(50), total: m.number().int().min(0) })
      .meta({ id: "PaginatedUsers" });

    const result = document31(
      { title: "Enterprise API", version: "2.1.0", description: "Enterprise" },
      { User, ErrorResponse, PaginatedUsers },
      {
        jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
        servers: [
          { url: "https://api.example.com/v1", description: "Prod" },
          { url: "https://staging.example.com/v1" },
        ],
        tags: [{ name: "users" }, { name: "system" }],
        security: [{ bearerAuth: [] }],
        externalDocs: { url: "https://docs.example.com", description: "Docs" },
        paths: {
          "/users": {
            get: {
              summary: "List users",
              operationId: "listUsers",
              tags: ["users"],
              parameters: [
                {
                  name: "page",
                  in: "query",
                  schema: m.number().int().min(1).default(1),
                  description: "Page",
                },
                { name: "limit", in: "query", schema: m.number().int().min(1).max(100) },
                {
                  name: "filter",
                  in: "query",
                  content: { "application/json": { schema: m.object({ q: m.string() }) } },
                },
              ],
              requestBody: { $ref: "#/components/requestBodies/CreateUser" },
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: PaginatedUsers,
                      example: { items: [] },
                      examples: { a: { value: { items: [] } } },
                      encoding: { a: { contentType: "application/json" } },
                    },
                  },
                },
                "401": { $ref: "#/components/responses/Unauthorized" },
                "400": {
                  description: "bad",
                  headers: { "X-Request-Id": { description: "id", schema: { type: "string" } } },
                  content: { "application/json": { schema: ErrorResponse } },
                  links: { GetUser: { operationId: "getUser" } },
                },
              },
              callbacks: {
                myCallback: {
                  "{$request.body#/callbackUrl}": {
                    post: { responses: { "200": { description: "ok" } } },
                  },
                },
              },
              deprecated: true,
              security: [{ apiKey: [] }],
              servers: [{ url: "https://api.example.com/v1" }],
              externalDocs: { url: "https://docs.example.com" },
            },
            post: {
              summary: "Create",
              requestBody: {
                description: "Create",
                required: true,
                content: { "application/json": { schema: User } },
              },
              responses: {
                "201": {
                  description: "Created",
                  content: { "application/json": { schema: User } },
                },
              },
            },
            put: { responses: { "200": { description: "ok" } } },
            delete: { responses: { "200": { description: "ok" } } },
            options: { responses: { "200": { description: "ok" } } },
            head: { responses: { "200": { description: "ok" } } },
            patch: { responses: { "200": { description: "ok" } } },
            trace: { responses: { "200": { description: "ok" } } },
          },
          "/users/{id}": {
            summary: "User by id",
            description: "Desc",
            servers: [{ url: "https://api.example.com/v1" }],
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: m.string().uuid(),
                description: "ID",
                deprecated: true,
                allowEmptyValue: true,
                style: "simple",
                explode: false,
                allowReserved: true,
                example: "123",
                examples: { a: { value: "123" } },
              },
            ],
            get: {
              responses: {
                "200": { description: "ok", content: { "application/json": { schema: User } } },
              },
            },
          },
          "/health": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: m.object({ status: m.literal("ok") }) },
                  },
                },
              },
            },
          },
        },
        webhooks: {
          orderCreated: {
            post: {
              summary: "Order created",
              operationId: "orderCreated",
              requestBody: { required: true, content: { "application/json": { schema: User } } },
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: {
          schemas: {
            Extra: m.object({ x: m.string() }).meta({ id: "Extra" }),
          },
          responses: {
            Unauthorized: {
              description: "Unauthorized",
              content: { "application/json": { schema: ErrorResponse } },
            },
            Paged: { $ref: "#/components/responses/Other" },
          },
          parameters: {
            PageParam: { name: "page", in: "query", schema: m.number().int().min(1) },
            RefParam: { $ref: "#/components/parameters/Other" },
          },
          requestBodies: {
            CreateUser: {
              description: "Create",
              content: { "application/json": { schema: User } },
            },
            RefBody: { $ref: "#/components/requestBodies/Other" },
          },
          headers: {
            "X-Request-Id": { description: "id", schema: { type: "string" } },
          },
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
          examples: { Foo: { summary: "foo", value: { a: 1 } } },
          links: { GetUser: { operationId: "getUser", parameters: { id: "$response.body#/id" } } },
          callbacks: {
            MyCb: { "{$url}": { get: { responses: { "200": { description: "ok" } } } } },
          },
          pathItems: {
            UserPath: {
              get: {
                summary: "Get",
                responses: {
                  "200": { description: "ok", content: { "application/json": { schema: User } } },
                },
              },
              parameters: [{ name: "id", in: "path", required: true, schema: m.string().uuid() }],
            },
          },
        },
      },
    );

    assert.equal(result.document.openapi, "3.1.0");
    assert.equal(
      result.document.jsonSchemaDialect,
      "https://spec.openapis.org/oas/3.1/dialect/base",
    );
    assert.equal(result.document.servers?.length, 2);
    assert.equal(result.document.tags?.length, 2);
    assert.deepEqual(result.document.security, [{ bearerAuth: [] }]);
    assert.equal(result.document.externalDocs?.url, "https://docs.example.com");
    assert.ok(result.document.paths["/users"]);
    assert.ok(result.document.paths["/users"]?.get);
    assert.equal(result.document.paths["/users"]?.get?.operationId, "listUsers");
    assert.equal(
      (result.document.paths["/users/{id}"]?.parameters?.[0] as { name: string })?.name,
      "id",
    );
    assert.ok(result.document.webhooks?.["orderCreated"]);
    assert.ok(result.document.components.schemas["User"]);
    assert.ok(result.document.components.schemas["Extra"]);
    assert.ok(result.document.components.responses?.["Unauthorized"]);
    assert.deepEqual(result.document.components.responses?.["Paged"], {
      $ref: "#/components/responses/Other",
    });
    assert.ok(result.document.components.parameters?.["PageParam"]);
    assert.deepEqual(result.document.components.parameters?.["RefParam"], {
      $ref: "#/components/parameters/Other",
    });
    assert.ok(result.document.components.requestBodies?.["CreateUser"]);
    assert.ok(result.document.components.securitySchemes?.["bearerAuth"]);
    assert.ok(result.document.components.headers?.["X-Request-Id"]);
    assert.ok(result.document.components.examples?.["Foo"]);
    assert.ok(result.document.components.links?.["GetUser"]);
    assert.ok(result.document.components.callbacks?.["MyCb"]);
    assert.ok(result.document.components.pathItems?.["UserPath"]);
    // Paths should use $ref for registered schemas
    assert.deepEqual(
      (
        result.document.paths["/users"]?.get?.responses?.["200"] as {
          content?: Record<string, { schema?: unknown }>;
        }
      )?.content?.["application/json"]?.schema,
      {
        $ref: "#/components/schemas/PaginatedUsers",
      },
    );
    // Check operation with $ref requestBody
    assert.deepEqual(result.document.paths["/users"]?.get?.requestBody, {
      $ref: "#/components/requestBodies/CreateUser",
    });
    // Check 3.1 uses type array for nullable? Not in this test
    assert.deepEqual(
      result.warnings.filter((w) => w.code === "webhooks-requires-3.1"),
      [],
    );
  });

  it("handles hostile keys in paths, webhooks, and components safely", () => {
    const schemas: Record<string, ReturnType<typeof m.string>> = {};
    Object.defineProperty(schemas, "__proto__", {
      value: m.string(),
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const result = document31({ title: "A", version: "1" }, schemas, {
      paths: { "/test": { get: { responses: { "200": { description: "ok" } } } } },
      webhooks: { test: { post: { responses: { "200": { description: "ok" } } } } },
      components: {
        responses: { Ok: { description: "ok" } },
        parameters: { P: { name: "p", in: "query", schema: m.string() } },
        requestBodies: { B: { content: { "application/json": { schema: m.string() } } } },
        pathItems: { PI: { get: { responses: { "200": { description: "ok" } } } } },
      },
    });
    assert.ok(Object.hasOwn(result.document.paths, "/test"));
    assert.ok(Object.hasOwn(result.document.webhooks!, "test"));
    assert.ok(Object.hasOwn(result.document.components.responses!, "Ok"));
    assert.ok(Object.hasOwn(result.document.components.parameters!, "P"));
    assert.ok(Object.hasOwn(result.document.components.requestBodies!, "B"));
    assert.ok(Object.hasOwn(result.document.components.pathItems!, "PI"));
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("warns and omits webhooks and jsonSchemaDialect in 3.0", () => {
    const User = m.object({ id: m.string() }).meta({ id: "User" });
    const result30 = document30(
      { title: "A", version: "1" },
      { User },
      {
        jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
        webhooks: { orderCreated: { post: { responses: { "200": { description: "ok" } } } } },
        paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
      },
    );
    assert.equal(result30.document.openapi, "3.0.3");
    assert.equal(result30.document.webhooks, undefined);
    assert.equal(
      (result30.document as unknown as { jsonSchemaDialect?: string }).jsonSchemaDialect,
      undefined,
    );
    const codes = result30.warnings.map((w) => w.code);
    assert.ok(codes.includes("webhooks-requires-3.1"));
    assert.ok(codes.includes("jsonSchemaDialect-requires-3.1"));

    const result31 = document31(
      { title: "A", version: "1" },
      { User },
      {
        webhooks: { hook: { post: { responses: { "200": { description: "ok" } } } } },
        paths: { "/x": { get: { responses: { "200": { description: "ok" } } } } },
      },
    );
    assert.ok(result31.document.webhooks?.["hook"]);
    assert.deepEqual(
      result31.warnings.filter((w) => w.code === "webhooks-requires-3.1"),
      [],
    );
  });

  it("converts schema inputs via $ref deduplication and raw OasSchema passthrough", () => {
    const User = m.object({ id: m.string() }).meta({ id: "User" });
    const raw: ReturnType<typeof oas31>["schema"] = {
      type: "object",
      properties: { raw: { type: "string" } },
    };
    const result = document31(
      { title: "A", version: "1" },
      { User },
      {
        paths: {
          "/a": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: User },
                    "text/plain": { schema: raw },
                    ref: { schema: { $ref: "#/components/schemas/User" } },
                  },
                },
              },
            },
          },
          "/b": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: {
          schemas: {
            RawSchema: raw,
            RefSchema: { $ref: "#/components/schemas/User" } as unknown as ReturnType<
              typeof m.string
            >,
          },
        },
      },
    );
    const resp = result.document.paths["/a"]?.get?.responses?.["200"] as {
      content?: Record<string, { schema?: unknown }>;
    };
    assert.deepEqual(resp?.content?.["application/json"]?.schema, {
      $ref: "#/components/schemas/User",
    });
    assert.deepEqual(resp?.content?.["text/plain"]?.schema, raw);
    assert.deepEqual(resp?.content?.["ref"]?.schema, { $ref: "#/components/schemas/User" });
    assert.deepEqual(result.document.components.schemas["RawSchema"], raw);
    assert.deepEqual(result.document.components.schemas["RefSchema"], {
      $ref: "#/components/schemas/User",
    });
  });

  it("handles media type with example, examples, encoding and headers, content, links", () => {
    const User = m.object({ id: m.string() }).meta({ id: "User" });
    const result = document31(
      { title: "A", version: "1" },
      { User },
      {
        paths: {
          "/x": {
            get: {
              parameters: [
                {
                  name: "q",
                  in: "query",
                  schema: m.string(),
                  content: {
                    "application/json": {
                      schema: User,
                      example: { id: "1" },
                      examples: { a: { value: { id: "1" } } },
                    },
                  },
                },
                { $ref: "#/components/parameters/Page" },
              ],
              responses: {
                "200": {
                  description: "ok",
                  headers: {
                    "X-Rate-Limit": { description: "limit", schema: { type: "integer" } },
                    RefHeader: { $ref: "#/components/headers/Other" },
                  },
                  content: {
                    "application/json": {
                      schema: User,
                      example: { id: "1" },
                      encoding: { a: { contentType: "application/json" } },
                    },
                  },
                  links: { GetUser: { operationId: "getUser" } },
                },
                "404": { $ref: "#/components/responses/NotFound" },
              },
            },
          },
        },
        components: {
          headers: { "X-Request-Id": { description: "id", schema: { type: "string" } } },
        },
      },
    );
    const param = result.document.paths["/x"]?.get?.parameters?.[0] as { content?: unknown };
    assert.ok(param?.content);
    const resp200 = result.document.paths["/x"]?.get?.responses?.["200"] as {
      headers?: Record<string, unknown>;
    };
    assert.ok(resp200?.headers?.["X-Rate-Limit"]);
    assert.deepEqual(result.document.paths["/x"]?.get?.parameters?.[1], {
      $ref: "#/components/parameters/Page",
    });
  });

  it("prefixes warnings with path for nested schemas", () => {
    const result = document31(
      { title: "A", version: "1" },
      { S: m.string().trim() },
      {
        paths: {
          "/x": {
            post: {
              requestBody: { content: { "application/json": { schema: m.string().trim() } } },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
    );
    // Warnings should be at S and at paths./x.post.requestBody...
    const codes = result.warnings.map((w) => w.code);
    assert.ok(codes.includes("normalizer-dropped"));
    const pathWarning = result.warnings.find((w) => w.path[0] === "paths");
    assert.ok(pathWarning);
  });
});
