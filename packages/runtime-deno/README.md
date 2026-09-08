# @minostack/runtime-deno

Deno adapter for `@minostack/mino` (experimental).

```ts
import { Mino } from "@minostack/mino";
import { serve } from "@minostack/runtime-deno";

const app = new Mino();
app.get("/", (c) => c.text("hello"));

serve(app, { port: 8000 });
```

Uses `Deno.serve(handler)` natively.
