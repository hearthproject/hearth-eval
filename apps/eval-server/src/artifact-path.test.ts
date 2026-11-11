import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRunOutputDir } from "./artifact-path.ts";

describe("resolveRunOutputDir", () => {
  it("maps eval artifact paths to the configured artifact root", () => {
    const repoRoot = "C:\\eval-repo";
    const artifactRoot = "D:\\hearth-os\\.hearth\\eval-artifacts";
    expect(resolveRunOutputDir(repoRoot, artifactRoot, ".hearth/eval-artifacts/EXP-1/E01/native/r1"))
      .toBe("D:\\hearth-os\\.hearth\\eval-artifacts\\EXP-1\\E01\\native\\r1");
    expect(resolveRunOutputDir(repoRoot, artifactRoot, ".hearth/eval-artifacts"))
      .toBe(artifactRoot);
  });

  it("keeps other output directories relative to the eval repo", () => {
    expect(resolveRunOutputDir("C:\\eval-repo", "D:\\artifacts", "custom/out"))
      .toBe(join("C:\\eval-repo", "custom", "out"));
  });
});
