/**
 * Basic: define a schema, infer its type, validate input.
 *
 * Copy this file into your project, `pnpm add @minostack/schema`, done.
 * Expected: `parse` returns the user; `safeParse` of `{ name: "A" }` fails
 * with a `too_small` issue at path `["name"]`.
 */

import { m } from "@minostack/schema";

export const User = m.object({
  id: m.string().uuid(),
  name: m.string().min(2).max(100),
  email: m.string().email(),
  age: m.number().int().min(0).optional(),
});

export type User = m.infer<typeof User>;

export const validInput = {
  id: "7e9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9",
  name: "Al",
  email: "al@example.com",
};

export const parsed: User = User.parse(validInput);
export const failure = User.safeParse({ ...validInput, name: "A" });
