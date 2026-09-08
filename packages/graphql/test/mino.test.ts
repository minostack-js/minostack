import { describe, it, expect } from "vitest";
import { m } from "@minostack/schema";
import { generateMinoSDL } from "../src/mino.js";

describe("graphql mino integration", () => {
  it("generates SDL from query mapping", () => {
    const User = m.object({ id: m.string(), name: m.string() });
    const { sdl } = generateMinoSDL({ User }, { query: { me: User } });
    expect(sdl).toContain("type User");
    expect(sdl).toContain("type Query");
    expect(sdl).toContain("me: User");
  });

  it("generates SDL with mutation", () => {
    const User = m.object({ id: m.string() });
    const CreateInput = m.object({ name: m.string() });
    const { sdl } = generateMinoSDL({ User, CreateInput }, { mutation: { createUser: User } });
    expect(sdl).toContain("type Mutation");
  });

  it("handles empty mapping", () => {
    const User = m.object({ id: m.string() });
    const { sdl } = generateMinoSDL({ User });
    expect(sdl).toContain("type User");
  });
});
