# @minostack/eslint-config

Shared ESLint flat-config base. Internal only (`private: true`, never published).

Usage in a package (`eslint.config.mjs`):

```js
import { base } from "@minostack/eslint-config/base";

export default [...base];
```

Requires `"@minostack/eslint-config": "workspace:*"` + `"eslint": "catalog:"` in the package's `devDependencies`, and the package `lint` script must run both layers:

```json
{ "scripts": { "lint": "oxlint && eslint ." } }
```

Package-specific policy (e.g. banning `node:*` imports in `src/`) goes in the package's own `eslint.config.mjs`, after `...base`.
