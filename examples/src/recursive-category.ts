/**
 * Recursion via `m.lazy`: the getter defers evaluation, so a schema may
 * reference itself. Converters need named roots for cycles — project with
 * `document31`, which emits `$ref`s under `components.schemas`.
 *
 * Expected: three levels parse to depth 3; the document names `Category`.
 */

import { m } from "@minostack/schema";
import type { Schema } from "@minostack/schema";
import { document31 } from "@minostack/openapi";

// Recursion needs explicit types: inference cannot close the loop when a
// schema appears in its own initializer, so the interfaces fix the value
// types and the `lazy` getter borrows them. Inputs may omit `children`
// (`.default([])` fills it in); outputs always carry it.
export interface Category {
  readonly name: string;
  readonly children: Category[];
}

export interface CategoryIn {
  readonly name: string;
  readonly children?: CategoryIn[] | undefined;
}

export const Category: Schema<Category, CategoryIn> = m.object({
  name: m.string().min(1),
  children: m.array(m.lazy((): Schema<Category, CategoryIn> => Category)).default([]),
});

export const tree: Category = Category.parse({
  name: "root",
  children: [{ name: "a", children: [{ name: "a-1" }] }],
});

export const document = document31({ title: "Shop API", version: "1.0.0" }, { Category });
