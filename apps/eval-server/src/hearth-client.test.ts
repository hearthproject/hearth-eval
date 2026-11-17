import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HearthClient } from "./hearth-client.ts";

describe("Hearth artifact adapter", () => {
  it("paginates the task trace until hasMore is false", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      const afterSeq = Number(new URL(url).searchParams.get("afterSeq") ?? "0");
      const body = afterSeq === 0
        ? {
            events: [
              { seq: 1, type: "task.created", runId: null, payload: {}, createdAt: "2026-11-17T00:00:00.000Z" },
              { seq: 2, type: "approval.created", runId: "run-1", payload: { status: "pending" }, createdAt: "2026-11-17T00:00:01.000Z" }
            ],
            hasMore: true,
            nextSeq: 2
          }
        : {
            events: [
              { seq: 3, type: "effect.updated", runId: "run-1", payload: { status: "succeeded" }, createdAt: "2026-11-17T00:00:02.000Z" }
            ],
            hasMore: false,
            nextSeq: 3
          };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new HearthClient({ baseUrl: "http://hearth.test", fetchImpl });

    const trace = await client.getTrace("task-1");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("afterSeq=2");
    expect(trace.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(trace.approvals).toBe(1);
    expect(trace.effects).toBe(1);
    expect(trace.primaryCause).toBe("none");
  });

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
