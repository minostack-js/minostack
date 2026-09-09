# Security Policy (draft for `1.0.0-alpha.0` preview)

> Mino is pre-release. This policy becomes binding at the first public
> prerelease (`1.0.0-alpha.0`). Until then it documents intent.

## Supported versions

| Version            | Status                               |
| ------------------ | ------------------------------------ |
| `1.0.0-alpha.x`    | Preview — security fixes, no LTS     |
| `1.0.0-beta/rc`    | Stabilization — fixes backported     |
| `1.0.x` (`latest`) | Stable — advisory + patch process    |
| `< 1.0.0` (`0.x`)  | Unpublished/dev only — not supported |

## Reporting a vulnerability

- Email the maintainers (see `package.json` `bugs` / repo contacts) with:
  affected package + version, repro (request/response pair), impact assessment.
- Do **not** open a public issue for unpatched vulnerabilities.
- Aim: acknowledge within 72h, patch preview within 14 days, credit reporters
  unless anonymity is requested.

## Secure defaults (enforced in code)

- Bodies capped (100kb JSON/text/form → `413`; multipart 10 files / 5MB each);
  query/header keys capped (100 keys, 8kb values → `400`); cookies capped
  (100 cookies, 8kb values → `400`); URIs capped (2048 chars / 128 slashes → `414`).
- Router 400s never echo segment bytes; 5xx responses never leak messages/stacks;
  error logs redact stacks (`[mino] errorHandler threw: Name: message`).
- `trustProxy` unset → `X-Forwarded-For` ignored (spoof-safe); runtime adapters
  overwrite `x-mino-peer` from the socket.
- CORS never reflects `*` with credentials; CSRF rejects cross-origin unsafe
  requests (403); session cookies are HMAC-signed; tampered sessions are
  discarded, never passed to handlers.
- Validation issues capped at 50, 500 chars each — third-party schema echoes
  cannot blow up or leak unbounded bodies into 422 responses.

## Production checklist

- Set `trustProxy` to match your deployment (count trusted hops, not `true`
  behind unknown proxies).
- Put a shared rate limiter / WAF in front for multi-instance deployments
  (built-in limiter is single-process memory).
- Terminate TLS before Mino or run HSTS-aware responses over `https:` only.
- Scrub PII in `app.onError` — never log `issues` verbatim.
- Pin versions, enable npm provenance/SBOM verification on install.

## Supply chain

- Zero runtime dependencies for `@minostack/mino` core and sub-paths
  (Web Standards only: Fetch, SubtleCrypto, CompressionStream).
- Publish path (trusted env only): frozen lockfile → `pnpm check` → `build` →
  `pack --dry-run` (tarball = `dist/` + manifest + README) → provenance publish.
