import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRunOutputDir } from "./artifact-path.ts";

describe("resolveRunOutputDir", () => {
  const repoRoot = resolve("eval-repo");
  const artifactRoot = resolve("hearth-os", ".hearth", "eval-artifacts");

  it("maps eval artifact paths to the configured artifact root", () => {
    expect(resolveRunOutputDir(repoRoot, artifactRoot, ".hearth/eval-artifacts/EXP-1/E01/native/r1"))
      .toBe(join(artifactRoot, "EXP-1", "E01", "native", "r1"));
    expect(resolveRunOutputDir(repoRoot, artifactRoot, ".hearth/eval-artifacts"))
      .toBe(artifactRoot);
  });

  it("normalizes Windows separators and a trailing slash", () => {
    expect(resolveRunOutputDir(repoRoot, artifactRoot, ".hearth\\eval-artifacts\\EXP-1\\"))
      .toBe(join(artifactRoot, "EXP-1"));
  });

  it("keeps other output directories relative to the eval repo", () => {
    expect(resolveRunOutputDir(repoRoot, artifactRoot, "custom/out"))
      .toBe(join(repoRoot, "custom", "out"));
  });
});

