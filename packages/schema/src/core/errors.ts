/**
 * Structured error model.
 *
 * Machine-readable `code` + `path` are the contract (stable across versions,
 * suitable for API responses, forms, and future localization). Human-readable
 * `message` strings are NOT contractual and may change.
 */

export type IssueCode =
  | "invalid_type"
  | "invalid_literal"
  | "invalid_enum"
  | "too_small"
  | "too_big"
  | "invalid_format"
  | "invalid_union"
  | "unrecognized_keys"
  | "invalid_intersection"
  | "custom";

export interface ValidationIssue {
  readonly code: IssueCode;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly expected?: unknown;
  readonly received?: unknown;
}

export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.length === 0 ? "Validation failed" : (issues[0]?.message ?? "Validation failed"));
    this.name = "ValidationError";
    this.issues = issues;
  }
}
