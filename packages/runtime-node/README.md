# @minostack/runtime-node

Direct Web-to-Node Stream Adapter for `@minostack/mino`.

```ts
import { Mino } from "@minostack/mino";
import { serve, toRequest, toNodeResponse } from "@minostack/runtime-node";

const app = new Mino();
app.get("/", (c) => c.text("hello"));

const server = serve(app, { port: 3000, hostname: "0.0.0.0", signal: AbortSignal.timeout(5000) });
```

- Converts `IncomingMessage` → `Request` (streaming body, no full buffering when possible)
- Converts `Response` → `ServerResponse` (streams `Response.body`, handles `set-cookie` correctly)
- `createNodeRequestListener(app)` for existing `http.createServer`
- `closeServer(server)` helper
- Low-overhead, no "zero-copy" marketing claims — profiled as direct stream adapter.
