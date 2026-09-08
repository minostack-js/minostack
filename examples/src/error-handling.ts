/**
 * Errors: `parse` throws `ValidationError` with `issues`; `safeParse`
 * returns the same error as data. Branch on `code` + `path` (stable
 * machine-readable contract) — never on `message` (human hint only).
 * Narrow `unknown` catches with `instanceof` and rethrow the rest: a bug in
 * a predicate must not masquerade as a validation failure.
 *
 * Expected: `main(bad)` is `["email: invalid_format", "age: too_small"]`,
 * `main(good)` is `["ok"]`; `throwing` mirrors both through `parse`.
 */

import { ValidationError, m } from "@minostack/schema";
import type { ValidationIssue } from "@minostack/schema";

export const Signup = m.object({
  email: m.string().email(),
  age: m.number().int().min(18),
});

export function summarize(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.code}`);
}

export const badSignup = { email: "not-an-email", age: 12 };
export const goodSignup = { email: "ada@example.com", age: 36 };

export function main(input: unknown): string[] {
  const result = Signup.safeParse(input);
  if (result.success) {
    return ["ok"];
  }
  return summarize(result.error.issues);
}

export function rethrowUnlessValidation(error: unknown): ValidationError {
  if (error instanceof ValidationError) {
    return error;
  }
  throw error;
}

export function throwing(input: unknown): string[] {
  try {
    Signup.parse(input);
    return ["ok"];
  } catch (error) {
    return summarize(rethrowUnlessValidation(error).issues);
  }
}
