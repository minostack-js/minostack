# @minostack/runtime-bun

Bun adapter for `@minostack/mino`.

```ts
import { Mino } from "@minostack/mino";
import { serve } from "@minostack/runtime-bun";

const app = new Mino();
app.get("/", (c) => c.text("hello"));

serve(app, { port: 3000 });
```

Uses `Bun.serve({ fetch: app.fetch })` natively. On non-Bun runtimes, throws with guidance to use `@minostack/runtime-node`.
