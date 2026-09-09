/**
 * upgrade.test.ts — createUpgradeListener: handshake bytes, protocol echo,
 * invalid-upgrade rejection. Hermetic (ephemeral port + direct invocation).
 */
import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { Mino } from "@minostack/mino";
import { createUpgradeListener, type UpgradeContext } from "../src/index.js";

const CLIENT_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const EXPECTED_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

function handshake(headers: Record<string, string>): string {
  const lines = ["GET /chat HTTP/1.1", "Host: localhost", "Connection: Upgrade"];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function readAll(socket: Socket): Promise<{ head: string; closed: boolean }> {
  return new Promise((resolve) => {
    let head = "";
    let closed = false;
    socket.on("data", (c) => {
      head += c.toString("utf8");
    });
    socket.on("close", () => {
      closed = true;
      resolve({ head, closed });
    });
    setTimeout(() => resolve({ head, closed }), 500).unref?.();
  });
}

describe("createUpgradeListener", () => {
  it("answers 101 with the RFC accept key and echoes raw bytes", async () => {
    const app = new Mino();
    const seen: UpgradeContext[] = [];
    const server: Server = createServer((_, res) => res.end("nope"));
    server.on(
      "upgrade",
      createUpgradeListener(app, (ctx) => {
        seen.push(ctx);
        ctx.socket.on("data", (chunk: Buffer) => ctx.socket.write(chunk));
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((r) => socket.on("connect", r));
    socket.write(
      handshake({
        Upgrade: "websocket",
        "Sec-WebSocket-Key": CLIENT_KEY,
        "Sec-WebSocket-Version": "13",
      }),
    );
    const first = await new Promise<string>((resolve) => {
      socket.once("data", (c) => resolve(c.toString("utf8")));
    });
    expect(first).toContain("HTTP/1.1 101");
    expect(first).toContain(`Sec-WebSocket-Accept: ${EXPECTED_ACCEPT}`);
    expect(first).not.toContain("Sec-WebSocket-Protocol");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.req.url).toContain("/chat");
    expect(seen[0]?.head.byteLength).toBe(0);

    socket.write("ping-bytes");
    const echoed = await new Promise<string>((resolve) => {
      socket.once("data", (c) => resolve(c.toString("utf8")));
    });
    expect(echoed).toBe("ping-bytes");

    socket.destroy();
    // The server-side socket only sees FIN ('end') — destroy it too, else
    // server.close() waits forever on the half-open hijacked socket.
    seen[0]?.socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("echoes the first offered subprotocol", async () => {
    const app = new Mino();
    const server: Server = createServer((_, res) => res.end("nope"));
    server.on(
      "upgrade",
      createUpgradeListener(app, ({ socket }) => socket.end()),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((r) => socket.on("connect", r));
    socket.write(
      handshake({
        Upgrade: "websocket",
        "Sec-WebSocket-Key": CLIENT_KEY,
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Protocol": "chat, super",
      }),
    );
    const first = await new Promise<string>((resolve) => {
      socket.once("data", (c) => resolve(c.toString("utf8")));
    });
    expect(first).toContain("Sec-WebSocket-Protocol: chat");
    socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("rejects a bad version with 400 and closes", async () => {
    const app = new Mino();
    const server: Server = createServer((_, res) => res.end("nope"));
    server.on(
      "upgrade",
      createUpgradeListener(app, () => {
        throw new Error("handler must not run");
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((r) => socket.on("connect", r));
    const done = readAll(socket);
    socket.write(
      handshake({
        Upgrade: "websocket",
        "Sec-WebSocket-Key": CLIENT_KEY,
        "Sec-WebSocket-Version": "12",
      }),
    );
    const { head, closed } = await done;
    expect(head).toContain("HTTP/1.1 400");
    expect(closed).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("rejects missing key / wrong method without calling the handler", async () => {
    const app = new Mino();
    let calls = 0;
    const listener = createUpgradeListener(app, () => {
      calls++;
    });
    const run = (
      headers: Record<string, string | string[]>,
      method = "GET",
    ): { out: string[]; destroyed: boolean } => {
      const out: string[] = [];
      let destroyed = false;
      listener(
        { method, headers, url: "/chat", socket: {} } as unknown as IncomingMessage,
        {
          write: (s: string) => {
            out.push(s);
            return true;
          },
          destroy: () => {
            destroyed = true;
          },
        } as unknown as Socket,
        Buffer.alloc(0),
      );
      return { out, destroyed };
    };
    const noKey = run({ upgrade: "websocket", "sec-websocket-version": "13" });
    expect(noKey.out[0]).toContain("400");
    expect(noKey.destroyed).toBe(true);

    const wrongMethod = run(
      { upgrade: "websocket", "sec-websocket-key": CLIENT_KEY, "sec-websocket-version": "13" },
      "POST",
    );
    expect(wrongMethod.out[0]).toContain("400");
    expect(wrongMethod.destroyed).toBe(true);

    const arrayUpgrade = run({
      upgrade: ["websocket"],
      "sec-websocket-key": CLIENT_KEY,
      "sec-websocket-version": "13",
    });
    expect(arrayUpgrade.destroyed).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
  });

  it("passes head bytes through and tolerates a failing socket write", async () => {
    const app = new Mino();
    const seen: UpgradeContext[] = [];
    const listener = createUpgradeListener(app, (ctx) => {
      seen.push(ctx);
    });
    listener(
      {
        method: "GET",
        url: "/chat",
        headers: {
          host: "localhost",
          upgrade: "websocket",
          "sec-websocket-key": CLIENT_KEY,
          "sec-websocket-version": "13",
          "sec-websocket-protocol": "chat",
        },
        socket: {},
      } as unknown as IncomingMessage,
      { write: () => true, destroy: () => {} } as unknown as Socket,
      Buffer.from([1, 2, 3]),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.head).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[0]?.req.url).toContain("/chat");

    let destroyed = false;
    listener(
      { method: "GET", headers: {}, url: "/" } as unknown as IncomingMessage,
      {
        write: () => {
          throw new Error("dead");
        },
        destroy: () => {
          destroyed = true;
        },
      } as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(destroyed).toBe(true);
  });
});
