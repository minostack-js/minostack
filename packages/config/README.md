# @minostack/config

> Schema-backed, redacted-by-default configuration (dev-mode preview).

```ts
import { m } from "@minostack/schema";
import { defineConfig, loadConfig, fromEnv } from "@minostack/config";

const ServerConfig = defineConfig(m.object({ port: m.number().int() }));
const cfg = loadConfig(ServerConfig, [fromEnv("APP_", process.env)]);
```

## Concepts

- `defineConfig(schema, { name, secrets })` — named config shape.
- `fromObject(obj)` / `fromEnv(prefix, env)` — merge layers (later wins).
- `loadConfig(def, sources)` — merged + validated + deep-frozen.
- `redactConfig(def, resolved)` — safe copy for logs/health.
- `formatConfigError(def, issues)` / `ConfigError` — actionable failures.

`src/` never touches `process` — inject `process.env` (or a test double) into `fromEnv`.

## Dev-mode limitations

- No file watcher or remote config source (pass parsed objects via `fromObject`).
- No encryption at rest; use a secret manager and inject values.
- Env values stay strings; schemas decide interpretation.
