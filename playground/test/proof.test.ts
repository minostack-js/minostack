import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "vitest";
import { practicals, runPractical, snapshotsDir } from "../src/practicals/index.js";
import { validateDtos as validateSignup } from "../src/practicals/signup.js";
import { validateDtos as validateBlog } from "../src/practicals/blog.js";

function snapshot(file: string): string {
  return readFileSync(join(snapshotsDir, file), "utf8");
}

describe("proof practicals", () => {
  it("signup DTOs validate with exact issues", () => {
    const report = validateSignup();
    assert.deepEqual(report.valid, {
      email: "ada@example.com",
      password: "correct-horse-9!",
      name: "Ada Lovelace",
      age: 36,
    });
    assert.deepEqual(
      report.invalidIssues.map((issue) => [issue.code, issue.path]),
      [
        ["invalid_format", ["email"]],
        ["too_small", ["password"]],
        ["too_small", ["name"]],
        ["too_small", ["age"]],
      ],
    );
  });

  it("blog DTOs validate with exact issues and a defaulted page", () => {
    const report = validateBlog();
    assert.deepEqual(report.valid, {
      items: [
        {
          id: "7e9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9",
          title: "Hello, proofs",
          status: "draft",
          author: { id: "8f9b4a1e-9c2e-4f1a-b2c3-d4e5f6a7b8c9", name: "Al" },
        },
      ],
      total: 1,
      page: 1,
    });
    assert.deepEqual(
      report.invalidIssues.map((issue) => [issue.code, issue.path]),
      [
        ["invalid_format", ["id"]],
        ["too_small", ["title"]],
        ["invalid_enum", ["status"]],
        ["invalid_format", ["author", "id"]],
        ["too_small", ["author", "name"]],
      ],
    );
  });

  it("converter warnings stay explicit", () => {
    const codes = new Map(practicals.map((p) => [p.name, p.warnings()]));
    assert.deepEqual(codes.get("signup"), ["refinement-dropped", "normalizer-dropped"]);
    assert.deepEqual(codes.get("blog"), []);
  });

  it("targets match the committed snapshots byte-exact", () => {
    for (const practical of practicals) {
      for (const [file, build] of Object.entries(practical.targets)) {
        assert.equal(build(), snapshot(file), `${practical.name}/${file} drifted`);
      }
    }
  });

  it("runPractical verifies fresh output against snapshots", () => {
    for (const practical of practicals) {
      const outDir = mkdtempSync(join(tmpdir(), "proof-verify-"));
      const report = runPractical(practical, outDir, snapshotsDir, { writeSnapshots: false });
      assert.equal(report.ok, true);
      for (const verdict of report.files) {
        assert.equal(verdict.matched, true);
        assert.equal(readFileSync(join(outDir, verdict.file), "utf8"), snapshot(verdict.file));
      }
    }
  });

  it("runPractical reports DIFF on drifted snapshots", () => {
    const outDir = mkdtempSync(join(tmpdir(), "proof-drift-out-"));
    const snapDir = mkdtempSync(join(tmpdir(), "proof-drift-snap-"));
    writeFileSync(join(snapDir, "signup.openapi.json"), "tampered");
    writeFileSync(join(snapDir, "signup.graphql"), snapshot("signup.graphql"));
    const signup = practicals.find((p) => p.name === "signup");
    assert.ok(signup);
    const report = runPractical(signup, outDir, snapDir, { writeSnapshots: false });
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.files.map((verdict) => [verdict.file, verdict.matched]),
      [
        ["signup.openapi.json", false],
        ["signup.graphql", true],
      ],
    );
  });

  it("runPractical reports MISSING snapshots on first run", () => {
    const outDir = mkdtempSync(join(tmpdir(), "proof-missing-out-"));
    const snapDir = mkdtempSync(join(tmpdir(), "proof-missing-snap-"));
    const signup = practicals.find((p) => p.name === "signup");
    assert.ok(signup);
    const report = runPractical(signup, outDir, snapDir, { writeSnapshots: false });
    assert.equal(report.ok, false);
    assert.ok(report.files.every((verdict) => verdict.matched === false));
  });

  it("runPractical refreshes snapshots with writeSnapshots", () => {
    const outDir = mkdtempSync(join(tmpdir(), "proof-update-out-"));
    const snapDir = mkdtempSync(join(tmpdir(), "proof-update-snap-"));
    const blog = practicals.find((p) => p.name === "blog");
    assert.ok(blog);
    const report = runPractical(blog, outDir, snapDir, { writeSnapshots: true });
    assert.equal(report.ok, true);
    for (const [file, build] of Object.entries(blog.targets)) {
      assert.equal(readFileSync(join(snapDir, file), "utf8"), build());
    }
  });
});
