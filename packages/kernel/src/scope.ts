/**
 * Provider scopes — deterministic semantics per §22.
 */

export type Scope = "singleton" | "request" | "transient";

export const SCOPE = {
  SINGLETON: "singleton" as const,
  REQUEST: "request" as const,
  TRANSIENT: "transient" as const,
};
