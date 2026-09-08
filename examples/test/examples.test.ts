import { assert, describe, it } from "vitest";
import { ValidationError } from "@minostack/schema";
import { failure, parsed } from "../src/basic-user.js";
import { slug, weakPassword } from "../src/refine-transform.js";
import { document, tree } from "../src/recursive-category.js";
import { api, userSchema } from "../src/openapi-document.js";
import { schema } from "../src/graphql-sdl.js";
import {
  badSignup,
  goodSignup,
  main,
  rethrowUnlessValidation,
  throwing,
} from "../src/error-handling.js";

describe("examples", () => {
  it("basic-user: parses valid input, rejects a short name", () => {
    assert.equal(parsed.name, "Al");
    assert.equal(failure.success, false);
    if (!failure.success) {
      assert.deepEqual(
        failure.error.issues.map((issue) => [issue.code, issue.path]),
        [["too_small", ["name"]]],
      );
    }
  });

  it("refine-transform: refines passwords, slugifies titles", () => {
    assert.equal(slug, "hello-world-");
    assert.equal(weakPassword.success, false);
    if (!weakPassword.success) {
      assert.equal(weakPassword.error.issues[0]?.code, "custom");
    }
  });

  it("recursive-category: parses trees, documents refs", () => {
    assert.equal(tree.children.length, 1);
    assert.deepEqual(Object.keys(document.document.components.schemas), ["Category"]);
  });

  it("openapi-document: emits a 3.1 document with named components", () => {
    assert.equal(api.document.openapi, "3.1.0");
    assert.deepEqual(Object.keys(api.document.components.schemas), ["User", "Status"]);
    assert.equal(userSchema.schema.properties?.["search"]?.pattern, "^adm");
  });

  it("graphql-sdl: emits types, inputs, and enums", () => {
    assert.ok(schema.sdl.includes("type Post {"));
    assert.ok(schema.sdl.includes("input PostInput {"));
    assert.ok(schema.sdl.includes("enum PostStatus {"));
    assert.ok(schema.sdl.includes("author: PostAuthor!"));
    assert.deepEqual(
      schema.warnings.map((warning) => warning.code),
      [],
    );
  });

  it("error-handling: summarizes codes and paths", () => {
    assert.deepEqual(main(badSignup), ["email: invalid_format", "age: too_small"]);
    assert.deepEqual(main(goodSignup), ["ok"]);
    assert.deepEqual(throwing(badSignup), ["email: invalid_format", "age: too_small"]);
    assert.deepEqual(throwing(goodSignup), ["ok"]);
  });

  it("error-handling: rethrows foreign exceptions", () => {
    const validation = new ValidationError([]);
    assert.equal(rethrowUnlessValidation(validation), validation);
    assert.throws(() => rethrowUnlessValidation(new TypeError("boom")), TypeError);
  });
});
