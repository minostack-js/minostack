/**
 * GraphQL: `sdl` projects named roots to SDL — one `type` (output) plus one
 * `input` per object, shared enums and unions, custom scalars (`DateTime`,
 * `BigInt`, `JSON`) where GraphQL has no equivalent.
 *
 * Expected: the SDL declares `type Post`, `input PostInput`, and the derived
 * `enum PostStatus`; the `author` field is non-null (`PostAuthor!`).
 */

import { m } from "@minostack/schema";
import { sdl } from "@minostack/graphql";

export const Status = m.enum(["draft", "published"]);

export const Author = m.object({
  id: m.string().uuid(),
  name: m.string().min(2),
});

export const Post = m.object({
  id: m.string().uuid(),
  title: m.string().min(1),
  status: Status,
  author: Author,
});

export const schema = sdl({ Post });
