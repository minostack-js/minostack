import { assert, describe, it } from "vitest";
import { ValidationError } from "@minostack/schema";
import { run as runUser } from "../src/user.js";
import { run as runRecursive } from "../src/recursive.js";
import { run as runOpenApi } from "../src/openapi.js";
import { run as runGraphql } from "../src/graphql.js";
import { formatIssues, rethrowUnlessValidation, run as runErrors } from "../src/errors.js";

describe("playground references", () => {
  it("parses the user domain model", () => {
    const summary = runUser();
    assert.equal(summary.name, "Ada Lovelace");
    assert.equal(summary.role, "member");
    assert.equal(summary.slug, "hello-playground-");
    assert.deepEqual(summary.previewKeys, ["id", "name"]);
  });

  it("walks recursive categories and documents them", () => {
    const summary = runRecursive();
    assert.equal(summary.depth, 3);
    assert.deepEqual(summary.componentNames, ["Category"]);
  });

  it("builds OpenAPI 3.1 and 3.0 projections", () => {
    const summary = runOpenApi();
    assert.equal(summary.openapiVersion, "3.1.0");
    assert.deepEqual(summary.componentNames, ["User", "Category"]);
    assert.equal(summary.trimsToString, true);
    assert.equal(summary.legacyIsObject, true);
  });

  it("projects GraphQL SDL with input/output pairs", () => {
    const summary = runGraphql();
    assert.equal(summary.declaresUser, true);
    assert.equal(summary.declaresUserInput, true);
    assert.equal(summary.declaresCategory, true);
  });

  it("formats validation failures as readable lines", () => {
    const summary = runErrors();
    assert.equal(summary.safeParseFailed, true);
    assert.equal(summary.parseThrew, true);
    assert.ok(summary.lines.length >= 4);
    assert.ok(summary.lines.some((line) => line.startsWith("id: invalid_format")));
  });

  it("formats root-level issues and rethrows foreign errors", () => {
    assert.deepEqual(formatIssues([{ code: "custom", path: [], message: "Nope" }]), [
      "<root>: custom — Nope",
    ]);
    const validation = new ValidationError([]);
    assert.equal(rethrowUnlessValidation(validation), validation);
    assert.throws(() => rethrowUnlessValidation(new TypeError("boom")), TypeError);
  });
});
