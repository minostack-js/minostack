/**
 * Shared types for scenario practicals. A practical pins one viable flow:
 * define schemas -> validate DTOs -> generate converter targets -> compare
 * the targets with committed snapshots. Scenarios import these types;
 * `index.ts` runs them.
 */

export interface IssueView {
  readonly code: string;
  readonly path: readonly string[];
}

export interface DtoReport {
  /** The parsed valid DTO (proves the happy path end to end). */
  readonly valid: Record<string, unknown>;
  /** Machine-readable issues for the invalid DTO, in field order. */
  readonly invalidIssues: readonly IssueView[];
}

export interface Practical {
  readonly name: string;
  readonly schemaNames: readonly string[];
  validate(): DtoReport;
  /** Converter warning codes across all targets (proves nothing is silent). */
  warnings(): readonly string[];
  /** Snapshot filename -> builder. Content is written/compared byte-exact. */
  readonly targets: Record<string, () => string>;
}

export interface FileVerdict {
  readonly file: string;
  readonly bytes: number;
  readonly matched: boolean;
}

export interface ProofReport {
  readonly name: string;
  readonly files: readonly FileVerdict[];
  readonly ok: boolean;
}
