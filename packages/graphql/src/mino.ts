/**
 * GraphQL integration for @minostack/mino (optional).
 * While GraphQL is not HTTP-route driven like REST, this helper
 * provides utilities to expose Mino handlers as GraphQL operations
 * via schema projection.
 *
 * For v0.1, GraphQL integration remains schema → SDL conversion;
 * Mino integration is a thin wrapper that helps build Query/Mutation roots
 * from controller metadata.
 */

import type { Schema } from "@minostack/schema";
import { sdl } from "./sdl.js";
import type { SdlOptions, SdlResult } from "./types.js";

export type MinoGraphQLMapping = {
  query?: Record<string, Schema<unknown, unknown>> | Schema<unknown, unknown>;
  mutation?: Record<string, Schema<unknown, unknown>> | Schema<unknown, unknown>;
  subscription?: Record<string, Schema<unknown, unknown>> | Schema<unknown, unknown>;
};

/**
 * Generate SDL from Mino-adjacent GraphQL operation maps.
 * Re-exports `sdl` with Mino-friendly naming.
 *
 * ```ts
 * const User = m.object({ id: m.string(), name: m.string() })
 * const { sdl: typeDefs } = generateMinoSDL({ User }, { query: { me: User } })
 * ```
 */
export function generateMinoSDL(
  types: Record<string, Schema<unknown, unknown>>,
  mapping: MinoGraphQLMapping = {},
  options?: SdlOptions,
): SdlResult {
  return sdl(types, {
    query: mapping.query,
    mutation: mapping.mutation,
    subscription: mapping.subscription,
    ...options,
  });
}

export { sdl as fromSchema, sdl as generateSDL } from "./sdl.js";
