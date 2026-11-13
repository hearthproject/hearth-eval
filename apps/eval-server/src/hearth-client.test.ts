import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HearthClient } from "./hearth-client.ts";

describe("Hearth artifact adapter", () => {
  it("reads nested text and binary metadata and skips oversized files", async ({ onTestFinished }) => {
    const repoRoot = mkdtempSync(join(tmpdir(), "eval-artifacts-"));
    onTestFinished(() => rmSync(repoRoot, { recursive: true, force: true }));
    const artifactRoot = join(repoRoot, ".hearth", "eval-artifacts");
    const outputDir = ".hearth/eval-artifacts/run-1";
    const root = join(repoRoot, outputDir);
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "nested", "result.md"), "结果", "utf8");
    writeFileSync(join(root, "data.json"), "{}", "utf8");
    writeFileSync(join(root, "image.png"), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, "large.txt"), "");
    truncateSync(join(root, "large.txt"), 20 * 1024 * 1024 + 1);
    const client = new HearthClient({ baseUrl: "http://unused.invalid", artifactStorage: { repoRoot, artifactRoot } });

    await expect(client.getArtifacts({ taskId: "task-1", outputDir })).resolves.toEqual({
      "nested/result.md": { text: "结果", bytes: Buffer.byteLength("结果"), mimeType: "text/markdown" },
      "data.json": { text: "{}", bytes: 2, mimeType: "application/json" },
      "image.png": { text: "", bytes: 3, mimeType: "application/octet-stream" }
    });
    await expect(client.getArtifacts({ taskId: "missing", outputDir: ".hearth/eval-artifacts/missing" })).resolves.toEqual({});
  });

  it("reads outputs from a separate OS repository", async ({ onTestFinished }) => {
    const root = mkdtempSync(join(tmpdir(), "eval-separate-repos-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const repoRoot = join(root, "hearth-eval");
    const artifactRoot = join(root, "hearth-os", ".hearth", "eval-artifacts");
    const outputDir = ".hearth/eval-artifacts/EXP-1/E01/native/r1";
    const runRoot = join(artifactRoot, "EXP-1", "E01", "native", "r1");
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(join(runRoot, "result.json"), "{}", "utf8");
    const client = new HearthClient({
      baseUrl: "http://unused.invalid",
      artifactStorage: { repoRoot, artifactRoot }
    });

    await expect(client.getArtifacts({ taskId: "task-1", outputDir })).resolves.toEqual({
      "result.json": { text: "{}", bytes: 2, mimeType: "application/json" }
    });
    await expect(client.getArtifacts({ taskId: "task-1", outputDir: ".hearth/eval-artifacts/../outside" }))
      .rejects.toThrow("评测产物目录越界");
  });

  it.each(["../outside", ".hearth/eval-artifacts-other/run-1"])("rejects an output outside the managed root: %s", async (outputDir) => {
    const repoRoot = join(tmpdir(), "eval-boundary");
    const client = new HearthClient({
      baseUrl: "http://unused.invalid",
      artifactStorage: { repoRoot, artifactRoot: join(repoRoot, ".hearth", "eval-artifacts") }
    });
    await expect(client.getArtifacts({ taskId: "task-1", outputDir })).rejects.toThrow("评测产物目录越界");
  });

  it("requires explicit local storage configuration", async () => {
    const client = new HearthClient({ baseUrl: "http://unused.invalid" });
    await expect(client.getArtifacts({ taskId: "task-1", outputDir: ".hearth/eval-artifacts/run-1" }))
      .rejects.toThrow("artifactStorage");
  });
});
