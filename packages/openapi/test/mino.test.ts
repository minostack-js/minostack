import { describe, it, expect } from "vitest";
import { Mino } from "@minostack/mino";
import { m } from "@minostack/schema";
import { generateMinoDocument } from "../src/mino.js";

describe("openapi mino integration", () => {
  it("generates document from Mino routes", () => {
    const app = new Mino();
    app.get("/users/:id", (c) => c.json({ id: c.param("id") }));
    app.post("/users", (c) => c.json({ ok: true }));

    const User = m.object({ id: m.string(), name: m.string() });
    const { document } = generateMinoDocument(app, { title: "Test", version: "1.0" }, { User });

    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/users/{id}"]).toBeDefined();
    expect(document.paths["/users/{id}"]?.get).toBeDefined();
    expect(document.paths["/users"]?.post).toBeDefined();
    expect(document.components.schemas["User"]).toBeDefined();
  });

  it("uses routeMap with input/output", () => {
    const app = new Mino();
    app.post("/users", (c) => c.json({ ok: true }));
    const CreateUser = m.object({ name: m.string() });
    const User = m.object({ id: m.string(), name: m.string() });
    const { document } = generateMinoDocument(
      app,
      { title: "T", version: "1.0" },
      { User, CreateUser },
      {
        routeMap: {
          "POST /users": {
            input: CreateUser,
            output: User,
            operation: { summary: "Create", tags: ["Users"] },
          },
        },
      },
    );
    const op = document.paths["/users"]?.post as {
      summary?: string;
      tags?: string[];
      requestBody?: unknown;
      responses?: unknown;
    };
    expect(op.summary).toBe("Create");
    expect(op.tags).toEqual(["Users"]);
    expect(op.requestBody).toBeDefined();
    expect(op.responses).toBeDefined();
  });

  it("supports Map routeMap", () => {
    const app = new Mino();
    app.get("/test", (c) => c.text("hi"));
    const map = new Map();
    map.set("GET /test", { operation: { summary: "Get test" } });
    const { document } = generateMinoDocument(
      app,
      { title: "T", version: "1.0" },
      {},
      { routeMap: map },
    );
    expect(document.paths["/test"]?.get?.summary).toBe("Get test");
  });

  it("converts wildcard path", () => {
    const app = new Mino();
    app.get("/files/*", (c) => c.text("f"));
    const { document } = generateMinoDocument(app, { title: "T", version: "1.0" }, {});
    expect(document.paths["/files/{wildcard}"]).toBeDefined();
  });

  it("generates 3.0 when version 3.0", () => {
    const app = new Mino();
    app.get("/", (c) => c.text("hi"));
    const { document } = generateMinoDocument(
      app,
      { title: "T", version: "1.0" },
      {},
      { version: "3.0" },
    );
    expect(document.openapi).toBe("3.0.3");
  });

  it("merges existing paths", () => {
    const app = new Mino();
    app.get("/a", (c) => c.text("a"));
    const { document } = generateMinoDocument(
      app,
      { title: "T", version: "1.0" },
      {},
      {
        paths: {
          "/existing": {
            get: { summary: "Existing", responses: { "200": { description: "ok" } } },
          },
        },
      },
    );
    expect(document.paths["/existing"]).toBeDefined();
    expect(document.paths["/a"]).toBeDefined();
  });

  it("handles ALL method? only standard methods are emitted", () => {
    const app = new Mino();
    app.all("/all", (c) => c.text("all"));
    const { document } = generateMinoDocument(app, { title: "T", version: "1.0" }, {});
    // all registers multiple methods; check at least GET exists
    expect(document.paths["/all"]?.get).toBeDefined();
  });
});
