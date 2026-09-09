/**
 * Enterprise: config + cache-aside workflow (dev-mode preview).
 *
 * Schema-validated config (with secret redaction) drives a cache-aside user
 * lookup. Expected: first call loads, second call hits; secrets stay masked.
 */

import { m } from "@minostack/schema";
import { defineConfig, loadConfig, fromObject, redactConfig } from "@minostack/config";
import { MemoryCache, cacheAside } from "@minostack/cache";

export const ServerConfig = defineConfig<{ port: number; dbUrl: string }>(
  m.object({ port: m.number().int(), dbUrl: m.string() }),
  { name: "server", secrets: ["dbUrl"] },
);

export const config = loadConfig(ServerConfig, [
  fromObject({ port: 3000, dbUrl: "postgres://app:s3cret@db:5432/app" }),
]);

export const redacted = redactConfig(ServerConfig, config);

const db = new Map([["1", { id: "1", name: "Ada" }]]);
export let dbReads = 0;

export const userCache = new MemoryCache<{ id: string; name: string }>();

export function findUser(id: string): Promise<{ id: string; name: string } | undefined> {
  return cacheAside(userCache, `users/${id}`, () => {
    dbReads++;
    return db.get(id);
  });
}
