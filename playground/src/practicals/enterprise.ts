/**
 * Practical: enterprise-grade API. Full `paths` + shared `components`
 * (schemas/responses/parameters/securitySchemes) + `servers`/`tags`/`security`
 * + `webhooks` (3.1 only), and GraphQL subgraph with `Query`/`Mutation`/
 * `Subscription` + Apollo Federation `@key`/`@shareable` directives.
 *
 * Steps: define -> validate DTOs -> generate targets -> compare with snapshots.
 */

import { m } from "@minostack/schema";
import { document31, document30 } from "@minostack/openapi";
import { sdl } from "@minostack/graphql";
import { rethrowUnlessValidation } from "../errors.js";
import { collectWarnings } from "./utils.js";
import type { DtoReport, IssueView, Practical } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const User = m
  .object({
    id: m.string().uuid(),
    email: m.string().email(),
    name: m.string().trim().min(2).max(100),
    role: m.enum(["admin", "member", "guest"]).default("member"),
    createdAt: m.string().datetime(),
  })
  .describe("Enterprise user.")
  .meta({ id: "User" })
  .facet("federation", { key: "id", shareable: true });

export const Product = m
  .object({
    id: m.string().uuid(),
    name: m.string().min(1).max(200),
    price: m.number().min(0),
    sku: m.string().optional(),
    tags: m.array(m.string().min(1)).max(10).optional(),
  })
  .describe("Catalog product.")
  .meta({ id: "Product" })
  .facet("federation", { key: "id", shareable: true });

export const OrderItem = m
  .object({
    productId: m.string().uuid(),
    quantity: m.number().int().min(1).max(100),
    price: m.number().min(0),
  })
  .describe("Single order line.")
  .meta({ id: "OrderItem" });

export const Order = m
  .object({
    id: m.string().uuid(),
    userId: m.string().uuid(),
    items: m.array(OrderItem).min(1).max(20),
    total: m.number().min(0),
    status: m.enum(["pending", "paid", "shipped", "cancelled"]).default("pending"),
    createdAt: m.string().datetime(),
  })
  .describe("Customer order.")
  .meta({ id: "Order" })
  .facet("federation", { key: "id" });

export const CreateOrderRequest = m
  .object({
    userId: m.string().uuid(),
    items: m
      .array(m.object({ productId: m.string().uuid(), quantity: m.number().int().min(1) }))
      .min(1),
  })
  .strict()
  .describe("POST /orders request body.")
  .meta({ id: "CreateOrderRequest" });

export const ErrorResponse = m
  .object({
    code: m.string(),
    message: m.string(),
    details: m.record(m.string()).optional(),
  })
  .describe("Standard error envelope.")
  .meta({ id: "ErrorResponse" });

export const PaginatedUsers = m
  .object({
    items: m.array(User).max(50),
    total: m.number().int().min(0),
    page: m.number().int().min(1).default(1),
    limit: m.number().int().min(1).max(100).default(20),
  })
  .describe("Paginated users envelope.")
  .meta({ id: "PaginatedUsers" });

export const PaginatedProducts = m
  .object({
    items: m.array(Product).max(50),
    total: m.number().int().min(0),
    page: m.number().int().min(1).default(1),
  })
  .describe("Paginated products envelope.")
  .meta({ id: "PaginatedProducts" });

// DTOs for validation

export const validOrder = {
  id: "7e9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9",
  userId: "8f9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9",
  items: [{ productId: "9f9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9", quantity: 2, price: 9.99 }],
  total: 19.98,
  status: "pending",
  createdAt: "2024-01-02T00:00:00.000Z",
};

export const invalidOrder = {
  id: "nope",
  userId: "bad",
  items: [],
  total: -5,
  status: "unknown",
  createdAt: "not-a-date",
};

export function validateDtos(): DtoReport {
  const valid = Order.parse(validOrder);
  let invalidIssues: IssueView[] = [];
  try {
    Order.parse(invalidOrder);
  } catch (error) {
    invalidIssues = rethrowUnlessValidation(error).issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
    }));
  }
  return { valid: valid as unknown as Record<string, unknown>, invalidIssues };
}

// ---------------------------------------------------------------------------
// OpenAPI: enterprise document
// ---------------------------------------------------------------------------

function buildEnterpriseOpenApiDocument31(): string {
  const doc = document31(
    {
      title: "Enterprise API",
      version: "2.1.0",
      description: "Enterprise-grade OpenAPI 3.1 with paths, components, webhooks, servers.",
    },
    {
      User,
      Product,
      Order,
      OrderItem,
      CreateOrderRequest,
      ErrorResponse,
      PaginatedUsers,
      PaginatedProducts,
    },
    {
      servers: [
        { url: "https://api.example.com/v1", description: "Production" },
        { url: "https://staging.api.example.com/v1", description: "Staging" },
        { url: "http://localhost:3000", description: "Local dev" },
      ],
      tags: [
        { name: "users", description: "User management" },
        { name: "products", description: "Catalog" },
        { name: "orders", description: "Orders" },
        { name: "system", description: "System/webhooks" },
      ],
      security: [{ bearerAuth: [] }],
      externalDocs: { description: "Full docs", url: "https://docs.example.com" },
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
                description: "Page number",
                schema: m.number().int().min(1).default(1),
                example: 1,
              },
              {
                name: "limit",
                in: "query",
                description: "Items per page",
                schema: m.number().int().min(1).max(100).default(20),
              },
            ],
            responses: {
              "200": {
                description: "Paginated users",
                content: { "application/json": { schema: PaginatedUsers } },
              },
              "401": { $ref: "#/components/responses/Unauthorized" },
              "429": {
                description: "Rate limited",
                headers: {
                  "Retry-After": {
                    description: "Seconds",
                    schema: { type: "integer" },
                  } as unknown as never,
                },
              },
            },
            security: [{ bearerAuth: [] }],
          },
          post: {
            summary: "Create user",
            operationId: "createUser",
            tags: ["users"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: m
                    .object({
                      email: m.string().email(),
                      name: m.string().min(2),
                      role: m.enum(["admin", "member"]).default("member"),
                    })
                    .meta({ id: "CreateUserRequest" }),
                },
              },
            },
            responses: {
              "201": {
                description: "Created user",
                content: { "application/json": { schema: User } },
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "422": { $ref: "#/components/responses/ValidationError" },
            },
          },
        },
        "/users/{id}": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "User ID",
              schema: m.string().uuid(),
            },
          ],
          get: {
            summary: "Get user by ID",
            operationId: "getUser",
            tags: ["users"],
            responses: {
              "200": { description: "User", content: { "application/json": { schema: User } } },
              "404": { $ref: "#/components/responses/NotFound" },
            },
          },
          put: {
            summary: "Update user",
            operationId: "updateUser",
            tags: ["users"],
            requestBody: { required: true, content: { "application/json": { schema: User } } },
            responses: {
              "200": {
                description: "Updated user",
                content: { "application/json": { schema: User } },
              },
              "404": { $ref: "#/components/responses/NotFound" },
            },
          },
          delete: {
            summary: "Delete user",
            operationId: "deleteUser",
            tags: ["users"],
            responses: {
              "204": { description: "No content" },
              "404": { $ref: "#/components/responses/NotFound" },
            },
          },
        },
        "/products": {
          get: {
            summary: "List products",
            operationId: "listProducts",
            tags: ["products"],
            parameters: [{ name: "page", in: "query", schema: m.number().int().min(1).default(1) }],
            responses: {
              "200": {
                description: "Paginated products",
                content: { "application/json": { schema: PaginatedProducts } },
              },
            },
          },
          post: {
            summary: "Create product",
            operationId: "createProduct",
            tags: ["products"],
            requestBody: { required: true, content: { "application/json": { schema: Product } } },
            responses: {
              "201": {
                description: "Created product",
                content: { "application/json": { schema: Product } },
              },
            },
          },
        },
        "/products/{id}": {
          get: {
            summary: "Get product",
            operationId: "getProduct",
            tags: ["products"],
            parameters: [{ name: "id", in: "path", required: true, schema: m.string().uuid() }],
            responses: {
              "200": {
                description: "Product",
                content: { "application/json": { schema: Product } },
              },
              "404": { $ref: "#/components/responses/NotFound" },
            },
          },
        },
        "/orders": {
          post: {
            summary: "Create order",
            operationId: "createOrder",
            tags: ["orders"],
            requestBody: {
              required: true,
              content: { "application/json": { schema: CreateOrderRequest } },
            },
            responses: {
              "201": {
                description: "Created order",
                content: { "application/json": { schema: Order } },
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "422": { $ref: "#/components/responses/ValidationError" },
            },
          },
          get: {
            summary: "List orders",
            operationId: "listOrders",
            tags: ["orders"],
            parameters: [
              {
                name: "status",
                in: "query",
                schema: m.enum(["pending", "paid", "shipped", "cancelled"]).optional(),
              },
              { name: "page", in: "query", schema: m.number().int().min(1).default(1) },
            ],
            responses: {
              "200": {
                description: "Paginated orders",
                content: {
                  "application/json": {
                    schema: m
                      .object({
                        items: m.array(Order).max(50),
                        total: m.number().int().min(0),
                        page: m.number().int().default(1),
                      })
                      .meta({ id: "PaginatedOrders" }),
                  },
                },
              },
            },
          },
        },
        "/orders/{id}": {
          get: {
            summary: "Get order",
            operationId: "getOrder",
            tags: ["orders"],
            parameters: [{ name: "id", in: "path", required: true, schema: m.string().uuid() }],
            responses: {
              "200": { description: "Order", content: { "application/json": { schema: Order } } },
              "404": { $ref: "#/components/responses/NotFound" },
            },
          },
        },
        "/health": {
          get: {
            summary: "Health check",
            operationId: "health",
            tags: ["system"],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: m.object({ status: m.literal("ok") }).meta({ id: "Health" }),
                  },
                },
              },
            },
          },
        },
      },
      webhooks: {
        orderCreated: {
          post: {
            summary: "Order created webhook",
            operationId: "orderCreatedWebhook",
            tags: ["system"],
            requestBody: { required: true, content: { "application/json": { schema: Order } } },
            responses: { "200": { description: "Webhook received" } },
          },
        },
        paymentSucceeded: {
          post: {
            summary: "Payment succeeded",
            operationId: "paymentSucceededWebhook",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: m
                    .object({ orderId: m.string().uuid(), amount: m.number().min(0) })
                    .meta({ id: "PaymentSucceeded" }),
                },
              },
            },
            responses: { "200": { description: "Payment webhook received" } },
          },
        },
        userSignedUp: {
          post: {
            summary: "User signed up",
            operationId: "userSignedUpWebhook",
            requestBody: { required: true, content: { "application/json": { schema: User } } },
            responses: { "200": { description: "Webhook received" } },
          },
        },
      },
      components: {
        responses: {
          NotFound: {
            description: "Resource not found",
            content: { "application/json": { schema: ErrorResponse } },
          },
          BadRequest: {
            description: "Bad request",
            content: { "application/json": { schema: ErrorResponse } },
          },
          Unauthorized: {
            description: "Unauthorized",
            content: { "application/json": { schema: ErrorResponse } },
          },
          ValidationError: {
            description: "Validation error",
            content: {
              "application/json": {
                schema: m
                  .object({
                    code: m.string(),
                    issues: m.array(m.object({ path: m.array(m.string()), message: m.string() })),
                  })
                  .meta({ id: "ValidationErrorResponse" }),
              },
            },
          },
        },
        parameters: {
          PageParam: {
            name: "page",
            in: "query",
            description: "Page number",
            schema: m.number().int().min(1).default(1),
          },
          LimitParam: {
            name: "limit",
            in: "query",
            schema: m.number().int().min(1).max(100).default(20),
          },
        },
        requestBodies: {
          CreateUser: {
            description: "Create user payload",
            content: {
              "application/json": {
                schema: m
                  .object({ email: m.string().email(), name: m.string().min(2) })
                  .meta({ id: "CreateUserBody" }),
              },
            },
          },
        },
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "JWT bearer token",
          },
          apiKey: { type: "apiKey", in: "header", name: "X-API-Key", description: "API key" },
          openId: {
            type: "openIdConnect",
            openIdConnectUrl: "https://auth.example.com/.well-known/openid-configuration",
          },
        },
        headers: {
          "X-Request-Id": { description: "Request ID", schema: { type: "string", format: "uuid" } },
        },
        pathItems: {
          UserPath: {
            get: {
              summary: "Reusable user path",
              responses: {
                "200": { description: "User", content: { "application/json": { schema: User } } },
              },
            },
          },
        },
      },
      jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    },
  );
  return `${JSON.stringify(doc.document, null, 2)}\n`;
}

function buildEnterpriseFederatedSdl(): string {
  // Federation demo: Query/Mutation/Subscription reuse existing types without duplicating declarations.
  // Field args are omitted here to keep type deduplication clean; see README for
  // the `facet("field", { args: { id: m.string() } })` pattern that adds args
  // per-field when needed (requires type reuse handling).
  const QueryFields = {
    me: User,
    user: User,
    users: m.array(User),
    product: Product,
    products: m.array(Product),
    order: Order,
    search: m.union([
      m.object({ id: m.string().uuid(), title: m.string() }).meta({ id: "Article" }),
      m.object({ id: m.string().uuid(), name: m.string() }).meta({ id: "Author" }),
    ]),
  };

  const MutationFields = {
    createUser: User,
    createOrder: Order,
    updateProduct: Product,
  };

  const SubscriptionFields = {
    orderUpdated: Order,
    productUpdated: Product,
  };

  const result = sdl(
    { User, Product, Order, OrderItem, ErrorResponse },
    {
      query: QueryFields,
      mutation: MutationFields,
      subscription: SubscriptionFields,
      federation: { enabled: true, version: "2.3" },
    },
  );
  return result.sdl;
}

function buildEnterprisePlainSdl(): string {
  const result = sdl({ User, Product, Order, ErrorResponse, PaginatedUsers });
  return result.sdl;
}

export function converterWarnings(): string[] {
  return collectWarnings([
    document31(
      { title: "Enterprise API", version: "2.1.0" },
      { User, Product, Order },
      {
        paths: {
          "/users": {
            get: {
              responses: {
                "200": { description: "ok", content: { "application/json": { schema: User } } },
              },
            },
          },
        },
        webhooks: { test: { post: { responses: { "200": { description: "ok" } } } } },
      },
    ),
    document30(
      { title: "Enterprise API", version: "2.1.0" },
      { User },
      {
        webhooks: { test: { post: { responses: { "200": { description: "ok" } } } } },
      },
    ),
    sdl({ User, Product, Order }),
    sdl(
      { User, Product },
      {
        query: { me: User },
        federation: { enabled: true },
      },
    ),
  ]);
}

export const practical: Practical = {
  name: "enterprise",
  schemaNames: [
    "User",
    "Product",
    "Order",
    "OrderItem",
    "CreateOrderRequest",
    "ErrorResponse",
    "PaginatedUsers",
    "PaginatedProducts",
  ],
  validate: validateDtos,
  warnings: converterWarnings,
  targets: {
    "enterprise.openapi.json": buildEnterpriseOpenApiDocument31,
    "enterprise.graphql": buildEnterprisePlainSdl,
    "enterprise-federated.graphql": buildEnterpriseFederatedSdl,
  },
};
