/**
 * In-depth reference: reading failures. `parse` throws `ValidationError`
 * carrying `issues`; `safeParse` returns the same error as data. Messages are
 * human hints only — branch on the machine-readable `code` + `path`, so
 * formatters and localization can layer on top later.
 */

import { ValidationError } from "@minostack/schema";
import type { ValidationIssue } from "@minostack/schema";
import { User } from "./user.js";

export function formatIssues(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => {
    const at = issue.path.length === 0 ? "<root>" : issue.path.map(String).join(".");
    return `${at}: ${issue.code} — ${issue.message}`;
  });
}

/**
 * Narrow an `unknown` catch: `parse` only throws `ValidationError`, so
 * anything else is a bug elsewhere (e.g. a throwing predicate) and must
 * propagate instead of masquerading as a validation failure.
 */
export function rethrowUnlessValidation(error: unknown): ValidationError {
  if (error instanceof ValidationError) {
    return error;
  }
  throw error;
}

export interface ErrorsSummary {
  readonly safeParseFailed: boolean;
  readonly parseThrew: boolean;
  readonly lines: readonly string[];
}

export function run(): ErrorsSummary {
  const bad = {
    id: "not-a-uuid",
    name: "A",
    email: "ada-at-example.com",
    password: "short",
    role: "superadmin",
  };
  const safe = User.safeParse(bad);
  let threw = false;
  let lines: string[] = [];
  try {
    User.parse(bad);
  } catch (error) {
    threw = true;
    lines = formatIssues(rethrowUnlessValidation(error).issues);
  }
  return {
    safeParseFailed: !safe.success,
    parseThrew: threw,
    lines,
  };
}
