/**
 * In-depth reference: recursion via `m.lazy`. The getter defers evaluation, so
 * a schema may reference itself. Converters need named roots for cycles — use
 * `document31` / `document30` (OpenAPI `$ref`s), never a bare `oas31` call.
 */

import { m } from "@minostack/schema";
import type { Schema } from "@minostack/schema";
import { document31 } from "@minostack/openapi";

// Self-reference needs explicit annotations on both sides: inference cannot
// close the loop (`Category` appears in its own initializer), so the
// interfaces fix the value types and the getter borrows them. Note the
// input/output split: parsed trees always have `children`, while callers may
// omit it (thanks to `.default([])`).
export interface Category {
  readonly name: string;
  readonly children: Category[];
}

export interface CategoryIn {
  readonly name: string;
  readonly children?: CategoryIn[] | undefined;
}

export const Category: Schema<Category, CategoryIn> = m
  .object({
    name: m.string().min(1),
    children: m.array(m.lazy((): Schema<Category, CategoryIn> => Category)).default([]),
  })
  .describe("A catalog category tree.")
  .meta({ id: "Category" });

export interface RecursiveSummary {
  readonly depth: number;
  readonly componentNames: readonly string[];
}

function depthOf(category: Category): number {
  if (category.children.length === 0) {
    return 1;
  }
  return 1 + Math.max(...category.children.map((child) => depthOf(child)));
}

export function run(): RecursiveSummary {
  const parsed = Category.parse({
    name: "root",
    children: [{ name: "a", children: [{ name: "a-1" }] }, { name: "b" }],
  });
  const converted = document31({ title: "Playground API", version: "0.0.0" }, { Category });
  return {
    depth: depthOf(parsed),
    componentNames: Object.keys(converted.document.components.schemas),
  };
}
