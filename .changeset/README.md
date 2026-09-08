# Changesets

This folder is managed by [`@changesets/cli`](https://github.com/changesets/changesets).

Add a changeset for every publishable package change:

```md
---
"@minostack/schema": minor
---

Add new capability.
```

Tooling-only changes do not need a changeset. See `docs/releasing.md`.
