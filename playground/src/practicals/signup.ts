/**
 * Practical: user signup. A `SignupRequest` DTO is validated, a `UserResponse`
 * DTO is derived from it, and both project to an OpenAPI 3.1 document and
 * GraphQL SDL. Steps: define -> validate DTOs -> generate targets -> compare
 * with `snapshots/signup.*`.
 */

import { m } from "@minostack/schema";
import { document31 } from "@minostack/openapi";
import { sdl } from "@minostack/graphql";
import { rethrowUnlessValidation } from "../errors.js";
import { collectWarnings } from "./utils.js";
import type { DtoReport, IssueView, Practical } from "./types.js";

export const SignupRequest = m
  .object({
    email: m.string().email(),
    password: m
      .string()
      .min(12)
      .refine((value) => /[0-9]/.test(value), { message: "include a digit" }),
    name: m.string().trim().min(2).max(100),
    age: m.number().int().min(18).optional(),
  })
  .strict()
  .describe("POST /signup request body.")
  .meta({ id: "SignupRequest" });

export const UserResponse = m
  .object({
    id: m.string().uuid(),
    email: m.string().email(),
    name: m.string(),
    role: m.enum(["admin", "member"]).default("member"),
    createdAt: m.string().datetime(),
  })
  .describe("User record returned by the API.")
  .meta({ id: "UserResponse" });

export const validSignup = {
  email: "ada@example.com",
  password: "correct-horse-9!",
  name: "  Ada Lovelace  ",
  age: 36,
};

export const invalidSignup = {
  email: "not-an-email",
  password: "short",
  name: "A",
  age: 15,
};

export function validateDtos(): DtoReport {
  const valid = SignupRequest.parse(validSignup);
  // The invalid DTO must throw: `parse` rejects by design, and the catch
  // below only runs on that path (no dead `success` arm to cover).
  let invalidIssues: IssueView[] = [];
  try {
    SignupRequest.parse(invalidSignup);
  } catch (error) {
    invalidIssues = rethrowUnlessValidation(error).issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
    }));
  }
  return { valid, invalidIssues };
}

export function buildOpenApi(): string {
  const converted = document31(
    { title: "Signup API", version: "1.0.0" },
    { SignupRequest, UserResponse },
  );
  return `${JSON.stringify(converted.document, null, 2)}\n`;
}

export function buildSdl(): string {
  return sdl({ UserResponse }).sdl;
}

export function converterWarnings(): string[] {
  return collectWarnings([
    document31({ title: "Signup API", version: "1.0.0" }, { SignupRequest, UserResponse }),
    sdl({ UserResponse }),
  ]);
}

export const practical: Practical = {
  name: "signup",
  schemaNames: ["SignupRequest", "UserResponse"],
  validate: validateDtos,
  warnings: converterWarnings,
  targets: {
    "signup.openapi.json": buildOpenApi,
    "signup.graphql": buildSdl,
  },
};
