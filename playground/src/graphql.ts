/**
 * In-depth reference: `@minostack/graphql`. `sdl` projects named roots to
 * GraphQL SDL — one `type` (output) plus one `input` per object, shared enums
 * and unions, custom scalars (`DateTime`, `BigInt`, `JSON`) for the rest.
 * Like OpenAPI, every approximation carries a warning.
 */

import { sdl } from "@minostack/graphql";
import { User } from "./user.js";
import { Category } from "./recursive.js";

export interface GraphqlSummary {
  readonly declaresUser: boolean;
  readonly declaresUserInput: boolean;
  readonly declaresCategory: boolean;
  readonly warningCodes: readonly string[];
}

export function run(): GraphqlSummary {
  const result = sdl({ User, Category });
  return {
    declaresUser: result.sdl.includes("type User {"),
    declaresUserInput: result.sdl.includes("input UserInput {"),
    declaresCategory: result.sdl.includes("type Category {"),
    warningCodes: result.warnings.map((warning) => warning.code),
  };
}
