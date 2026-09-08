import { assert, describe, it } from "vitest";
import { ValidationError, m } from "../src/index.ts";
import type { ValidationIssue } from "../src/index.ts";

describe("@minostack/schema scaffold", () => {
  it("exposes the placeholder public entry", () => {
    assert.ok(m !== undefined);
    assert.equal(typeof ValidationError, "function");
  });

  it("constructs a ValidationError with issues", () => {
    const issue: ValidationIssue = {
      code: "custom",
      path: ["name"],
      message: "Invalid",
    };
    const error = new ValidationError([issue]);
    assert.equal(error.name, "ValidationError");
    assert.equal(error.issues.length, 1);
    assert.ok(error instanceof Error);
  });
});
