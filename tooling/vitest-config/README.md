# `@minostack/vitest-config`

Shared Vitest base config for minostack-js workspaces. Private (`private: true`), never published.

```ts
// <workspace>/vitest.config.ts
import { defineWorkspace } from "@minostack/vitest-config/base";

export default defineWorkspace();
```

What the base sets: Node environment, `test/**/*.test.ts` includes, V8 coverage over `src/**/*.ts` with the repo 90% gate (lines / branches / functions / statements). Extra `exclude` entries are reserved for type-only modules V8 still loads — each must be justified at the call site.
