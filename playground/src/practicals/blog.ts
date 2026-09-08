/**
 * Practical: blog listing. Nested `Author`/`Post` DTOs plus a `PostsPage`
 * envelope with a defaulted page number. Steps: define -> validate DTOs ->
 * generate targets -> compare with `snapshots/blog.*`.
 */

import { m } from "@minostack/schema";
import { document31 } from "@minostack/openapi";
import { sdl } from "@minostack/graphql";
import { rethrowUnlessValidation } from "../errors.js";
import { collectWarnings } from "./utils.js";
import type { DtoReport, IssueView, Practical } from "./types.js";

export const Author = m
  .object({
    id: m.string().uuid(),
    name: m.string().min(2),
  })
  .describe("Post author.")
  .meta({ id: "Author" });

export const Status = m.enum(["draft", "published"]).describe("Post status.");

export const Post = m
  .object({
    id: m.string().uuid(),
    title: m.string().min(1),
    status: Status,
    author: Author,
  })
  .describe("A blog post.")
  .meta({ id: "Post" });

export const PostsPage = m
  .object({
    items: m.array(Post).max(50),
    total: m.number().int().min(0),
    page: m.number().int().min(1).default(1),
  })
  .describe("GET /posts response envelope.")
  .meta({ id: "PostsPage" });

export const validPost = {
  id: "7e9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9",
  title: "Hello, proofs",
  status: "draft",
  author: { id: "8f9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9", name: "Al" },
};

export const invalidPost = {
  id: "nope",
  title: "",
  status: "junk",
  author: { id: "bad", name: "X" },
};

export const validPage = {
  items: [validPost],
  total: 1,
};

export function validateDtos(): DtoReport {
  const valid = PostsPage.parse(validPage);
  // The invalid DTO must throw: `parse` rejects by design, and the catch
  // below only runs on that path (no dead `success` arm to cover).
  let invalidIssues: IssueView[] = [];
  try {
    Post.parse(invalidPost);
  } catch (error) {
    invalidIssues = rethrowUnlessValidation(error).issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
    }));
  }
  return { valid, invalidIssues };
}

export function buildOpenApi(): string {
  const converted = document31({ title: "Blog API", version: "1.0.0" }, { Post, PostsPage });
  return `${JSON.stringify(converted.document, null, 2)}\n`;
}

export function buildSdl(): string {
  return sdl({ Post, PostsPage }).sdl;
}

export function converterWarnings(): string[] {
  return collectWarnings([
    document31({ title: "Blog API", version: "1.0.0" }, { Post, PostsPage }),
    sdl({ Post, PostsPage }),
  ]);
}

export const practical: Practical = {
  name: "blog",
  schemaNames: ["Author", "Status", "Post", "PostsPage"],
  validate: validateDtos,
  warnings: converterWarnings,
  targets: {
    "blog.openapi.json": buildOpenApi,
    "blog.graphql": buildSdl,
  },
};
