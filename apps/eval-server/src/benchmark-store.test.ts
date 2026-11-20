import { describe, expect, it } from "vitest";
import type { BenchmarkRunSummary, BenchmarkTrial } from "@hearth/eval-core";
import { EvalStore } from "./store.ts";

function trial(overrides: Partial<BenchmarkTrial> = {}): BenchmarkTrial {
  return {
    id: overrides.id ?? "bt-1",
    runId: overrides.runId ?? "br-1",
    taskId: overrides.taskId ?? "task-task-a",
    taskKey: overrides.taskKey ?? "task-a",
    trialKey: overrides.trialKey ?? "trial-a-1",
    attempt: overrides.attempt ?? 1,
    reward: overrides.reward ?? 1,
    status: overrides.status ?? "passed",
    durationMs: overrides.durationMs ?? 1000,
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 10,
    cachedTokens: overrides.cachedTokens ?? 0,
    costUsd: overrides.costUsd ?? 0.01,
    rewardPath: overrides.rewardPath ?? "verifier/reward.txt",
    resultPath: overrides.resultPath ?? "result.json",
    errorCode: overrides.errorCode ?? null,
    errorMessage: overrides.errorMessage ?? null,
    verifierStdout: overrides.verifierStdout ?? null,
    verifierStderr: overrides.verifierStderr ?? null,
    raw: overrides.raw ?? { reward: 1 },
    createdAt: overrides.createdAt ?? "2026-11-20T00:00:00.000Z"
  };
}

const summary: BenchmarkRunSummary = {
  totalTasks: 1,
  totalTrials: 1,
  validTrials: 1,
  passedTrials: 1,
  failedTrials: 0,
  partialTrials: 0,
  errorTrials: 0,
  timeoutTrials: 0,
  budgetExceededTrials: 0,
  skippedTrials: 0,
  meanReward: 1,
  passRate: 1,
  passAt5: null,
  passAt5TaskCount: 0,
  resolvedTasks: 1,
  partialTasks: 0,
  inputTokens: 100,
  outputTokens: 10,
  cachedTokens: 0,
  totalTokens: 110,
  costUsd: 0.01,
  costKnownTrials: 1,
  costPerSolvedUsd: 0.01,
  avgDurationMs: 1000,
  infraErrorRate: 0,
  wilson95: { lower: 0.2, upper: 1 }
};

describe("BenchmarkStore", () => {
  it("persists datasets, tasks, runs, trials, and summaries", () => {
    const store = new EvalStore(":memory:");
    const dataset = store.benchmarks.saveDataset({
      id: "terminal-bench/terminal-bench-2-1@2.1",
      name: "terminal-bench/terminal-bench-2-1",
      version: "2.1",
      source: "harbor",
      commitSha: "7131e4375048a0e408a8fb404b5f499d726b695b",
      digest: "sha256:mini",
      taskCount: 89,
      createdAt: "2026-11-20T00:00:00.000Z"
    });
    expect(dataset.taskCount).toBe(89);
    expect(store.benchmarks.getDataset(dataset.id)?.version).toBe("2.1");

    const task = store.benchmarks.upsertTask({
      id: "task-task-a",
      datasetId: dataset.id,
      taskKey: "task-a",
      instructionPath: "task-a/instruction.md",
      imageRef: "task-a:latest",
      timeoutSec: 3600,
      metadata: { difficulty: "easy" }
    });
    expect(task.metadata).toEqual({ difficulty: "easy" });

    const run = store.benchmarks.saveRun({
      id: "br-1",
      datasetId: dataset.id,
      jobId: "job-mini",
      harnessName: "hearth-native",
      harnessVersion: "0.1.0",
      model: "test-model",
      status: "imported",
      startedAt: "2026-11-20T00:00:00.000Z",
      endedAt: null,
      config: { agent: "hearth-native" },
      rawDir: "D:/jobs/job-mini",
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z"
    });
    expect(run.summary).toBeNull();

    store.benchmarks.replaceTrials("br-1", [
      trial({ id: "bt-1", trialKey: "trial-a-1", taskKey: "task-a" }),
      trial({ id: "bt-2", trialKey: "trial-b-1", taskKey: "task-b", taskId: "task-task-b", reward: 0, status: "failed" }),
      trial({ id: "bt-3", trialKey: "trial-b-2", taskKey: "task-b", taskId: "task-task-b", reward: null, status: "timeout" })
    ]);
    expect(store.benchmarks.listTrials("br-1")).toHaveLength(3);
    expect(store.benchmarks.listTrials("br-1", { taskKey: "task-b" })).toHaveLength(2);
    expect(store.benchmarks.listTrials("br-1", { status: "passed" })).toHaveLength(1);
    expect(store.benchmarks.countTrials("br-1", { taskKey: "task-b" })).toBe(2);
    expect(store.benchmarks.getTrial("br-1", "bt-3")?.status).toBe("timeout");

    store.benchmarks.updateRunSummary("br-1", "imported", summary, "2026-11-20T01:00:00.000Z");
    const updated = store.benchmarks.getRun("br-1");
    expect(updated?.summary?.meanReward).toBe(1);
    expect(updated?.endedAt).toBe("2026-11-20T01:00:00.000Z");

    store.benchmarks.replaceTrials("br-1", [trial({ id: "bt-4", trialKey: "trial-a-1" })]);
    expect(store.benchmarks.listTrials("br-1")).toHaveLength(1);
    expect(store.benchmarks.countTrials("br-1")).toBe(1);
    store.close();
  });

  it("upserts the same run without duplicating it", () => {
    const store = new EvalStore(":memory:");
    const datasetId = "dataset";
    store.benchmarks.saveDataset({
      id: datasetId,
      name: "dataset",
      version: "1",
      source: "harbor",
      commitSha: null,
      digest: null,
      taskCount: 1,
      createdAt: "2026-11-20T00:00:00.000Z"
    });
    const input = {
      id: "br-same",
      datasetId,
      jobId: "job",
      harnessName: "hearth",
      harnessVersion: "1",
      model: "m",
      status: "imported" as const,
      startedAt: null,
      endedAt: null,
      config: {},
      rawDir: "D:/jobs/job",
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z"
    };
    store.benchmarks.saveRun(input);
    store.benchmarks.saveRun({ ...input, updatedAt: "2026-11-20T01:00:00.000Z" });
    expect(store.benchmarks.listRuns()).toHaveLength(1);
    expect(store.benchmarks.getRun("br-same")?.updatedAt).toBe("2026-11-20T01:00:00.000Z");
    store.close();
  });
});
