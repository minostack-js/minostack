/**
 * Playground entry: runs every scenario and prints the summaries.
 * `pnpm --filter @minostack/playground start` (once) or `dev` (watch).
 */

import { run as runUser } from "./user.js";
import { run as runRecursive } from "./recursive.js";
import { run as runOpenApi } from "./openapi.js";
import { run as runGraphql } from "./graphql.js";
import { run as runErrors } from "./errors.js";

function show(title: string, summary: unknown): void {
  console.log(`\n### ${title}`);
  console.log(JSON.stringify(summary, null, 2));
}

show("user", runUser());
show("recursive", runRecursive());
show("openapi", runOpenApi());
show("graphql", runGraphql());
show("errors", runErrors());
