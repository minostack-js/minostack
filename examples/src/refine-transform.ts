/**
 * Refinements (runtime-only predicates) and transforms (input/output split).
 *
 * Expected: `"longpassword!!"` (12+ chars, no digit) fails the refinement
 * with code `custom`; `Slug.parse("Hello, World!")` returns
 * `"hello-world-"`, and `m.input` / `m.output` expose the two sides.
 */

import { m } from "@minostack/schema";

export const Password = m
  .string()
  .min(12)
  .refine((value) => /[0-9]/.test(value), { message: "include a digit" });

export const Slug = m
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

export type SlugIn = m.input<typeof Slug>; // string
export type SlugOut = m.output<typeof Slug>; // string

export const slug = Slug.parse("Hello, World!");
export const weakPassword = Password.safeParse("longpassword!!");
