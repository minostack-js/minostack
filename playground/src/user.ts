/**
 * In-depth reference: a `User` domain model exercising the `@minostack/schema`
 * surface in one place — string/number/enum/date checks, `optional` vs
 * `nullable`, `default`, `refine`, `transform` (with distinct input/output),
 * `describe`/`meta`/`facet`, object utils (`pick`, `partial`, `strict`), and
 * static inference via `m.infer` / `m.input` / `m.output`.
 */

import { m } from "@minostack/schema";

export const Password = m
  .string()
  .min(12)
  .refine((value) => /[0-9]/.test(value) && /[^0-9A-Za-z]/.test(value), {
    message: "use digits, letters, and a symbol",
  })
  .describe("Raw password: validated, never stored (see PasswordHash).");

export const User = m
  .object({
    id: m.string().uuid().describe("Stable identifier."),
    name: m.string().trim().min(2).max(100),
    email: m.string().email(),
    // `optional()` models a missing key (`| undefined`); `nullable()` models an
    // explicit `null`. They compose: `optional().nullable()` allows both.
    nickname: m.string().min(2).nullable().optional(),
    age: m.number().int().min(0).max(150).optional(),
    role: m.enum(["admin", "member", "guest"]).default("member"),
    password: Password,
    createdAt: m.date().optional(),
  })
  .strict()
  .describe("Canonical user record.")
  .meta({ id: "User", title: "User" })
  .facet("acme", { pii: ["email", "password"] });

export type User = m.infer<typeof User>;
export type UserInput = m.input<typeof User>;

// Derived views preserve the node graph: `pick` keeps metadata, `partial`
// makes every field optional for PATCH-style payloads.
export const UserPreview = User.pick({ id: true, name: true });
export const UserPatch = User.partial();

// `transform` splits the types: callers pass a string, readers get a slug.
export const Slug = m
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

export type SlugInput = m.input<typeof Slug>; // string
export type SlugOutput = m.output<typeof Slug>; // string (same here, distinct in general)

export interface UserSummary {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly slug: string;
  readonly previewKeys: readonly string[];
}

export function run(): UserSummary {
  const parsed = User.parse({
    id: "7e9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9",
    name: "  Ada Lovelace  ",
    email: "ada@example.com",
    nickname: null,
    role: undefined,
    password: "correct-horse-9!",
  });
  return {
    id: parsed.id,
    name: parsed.name,
    role: parsed.role,
    slug: Slug.parse("  Hello, Playground!  "),
    previewKeys: Object.keys(UserPreview.parse({ id: parsed.id, name: parsed.name })),
  };
}
