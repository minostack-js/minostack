import { base } from "@minostack/eslint-config/base";

// Playground runs on Node at dev time: platform APIs are allowed here.
// (Publishable packages keep the opposite rule — no `node:*` in `src/`.)
export default [...base];
