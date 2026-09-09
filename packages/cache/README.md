# @minostack/cache

> Replaceable cache port with dev-mode memory implementation.

```ts
import { MemoryCache, cacheAside } from "@minostack/cache";

const cache = new MemoryCache();
const user = await cacheAside(cache, "users/1", () => db.find(1), 60_000);
```

## Concepts

- `Cache` — `get`/`set`/`del`/`clear` port (sync or async).
- `MemoryCache` — TTL + entry cap, injectable clock.
- `namespaced(prefix, cache)` — tenant/feature isolation.
- `cacheAside(cache, key, loader, ttlMs)` — load-once, failures never cached.
- `withNegativeCache(inner)` — loader misses stored as markers.
- `withStampede(inner)` — concurrent `getOrLoad` shares one loader promise.

## Dev-mode limitations

- `MemoryCache` is single-process and non-durable.
- No Redis/distributed backend included; implement `Cache` against one.
- TTL uses the injected clock (defaults to `Date.now`).
