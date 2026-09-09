I cloned the repo and actually ran the test suite, typecheck, and lint against `packages/mino` rather than just reading — here's what's real.

**Snapshot:** v0.0.0 (unpublished), ~2,770 LOC across 16 source files, Fetch-native (Request/Response, no Node deps in core). Verified: **166/166 tests pass**, typecheck clean, lint clean (16 cosmetic unused-type-param warnings only). Coverage: 89.1% stmts / 78.8% branch — just under the 90% gate the project sets for itself.

**What's genuinely solid**

- **Router**: radix trie with a static-route fast-map bypass, correct static>param>wildcard priority, bounded recursion (2048-char/128-slash caps → 414), no ReDoS surface (no regex routing).
- **Request hardening**: real demand limits — 100kb body caps enforced via content-length pre-check _and_ streaming byte-count (not just header trust), bounded query/header key counts and value lengths, 429/413/414 all correctly coded.
- **Security posture**: `helmet`/`cors`/`rate-limit` are careful — CORS never reflects `*` with credentials, rate-limit correctly refuses to trust `X-Forwarded-For` unless `trustProxy` is set (client IP spoofing closed), 5xx messages never leak internals, error stacks are redacted in logs.
- **Errors**: clean `HttpError` hierarchy, sensible expose/hide-by-status-code default.
- Zero required runtime dependencies; validator works with any Standard-Schema library (Zod/Valibot/ArkType) via duck-typed fallback — genuinely nice API design.

**Real issues found**

1. **License mismatch (real, not cosmetic)** — root `LICENSE` file is **Apache-2.0**, but `packages/mino/package.json` declares `"license": "MIT"`. This is a legal-compliance blocker for any enterprise adopter doing license scanning; must be fixed before anyone can responsibly depend on it.
2. **Benchmark honesty gap** — the Express comparison in `apps/benchmark` drives Express through a mocked req/res object, not a real listening socket, while presumably testing Mino via its native fetch handler. Any "faster than Express" claim from this harness isn't apples-to-apples yet. The team's own `ongoing.md` already flags this as open (Phase D2, real-socket harness).
3. **No changeset for `@minostack/mino`** — three changesets exist (schema/openapi/graphql), none for mino, despite it having the most recent work. `changeset publish` would ship it without a documented version bump — also self-tracked (Phase E2).
4. **`compose.ts` middleware pipeline is over-permissive** — if a handler neither calls `next()` nor returns a `Response`, the composer silently auto-advances to the next handler "for compatibility." That's a footgun: a middleware bug (forgotten `next()`) becomes invisible behavior instead of a stuck request, undermining the "reliable like Express" goal. Worth tightening to fail loud in a debug/dev mode at least.
5. **Coverage below stated gate** (89.1% vs. 90% target) — mostly in `compose.ts` (79%) and `validator.ts` (84%), i.e. exactly the two files with the most branching logic above.

**Already tracked, not yet done** (from the team's own `ongoing.md`, which is unusually honest and worth keeping): SSE backpressure not respecting `desiredSize`, pipeline cache eviction is FIFO not LRU (fine for now, flagged as a risk at >1024 routes), `decodeRemainder` has an O(n²) path.

**Verdict:** The engineering discipline is well above typical "phi"-stage frameworks — real hardening tests, honest self-tracking, no dependency bloat. It is not yet honest to market as "beats Express" until the benchmark harness is fixed, and the license/changeset gaps are simple but real blockers before treating this as production/enterprise-ready. Architecturally it's in good shape to get there.
