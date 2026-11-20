import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EvalStore } from "./store.ts";
import {
  BenchmarkImportError,
  buildBenchmarkRunId,
  importHarborJob,
  listHarborJobCandidates
} from "./benchmark-import.ts";

const fixtureRoot = fileURLToPath(new URL("../test/fixtures", import.meta.url));

function importMini(store: EvalStore, jobDir = "harbor-job-mini") {
  return importHarborJob({
    store,
    jobsRoot: fixtureRoot,
    input: { jobDir },
    now: () => new Date("2026-11-20T12:00:00.000Z")
  });
}

describe("importHarborJob", () => {
  it("imports pass, fail, error, timeout, reward-json and text fallback trials", () => {
    const store = new EvalStore(":memory:");
    const result = importMini(store);
    expect(result.trialCount).toBe(5);
    expect(result.taskCount).toBe(5);
    expect(result.summary.validTrials).toBe(3);
    expect(result.summary.passedTrials).toBe(2);
    expect(result.summary.failedTrials).toBe(1);
    expect(result.summary.errorTrials).toBe(1);
    expect(result.summary.timeoutTrials).toBe(1);
    expect(result.summary.meanReward).toBeCloseTo(2 / 3);
    expect(result.summary.resolvedTasks).toBe(2);
    expect(result.summary.totalTokens).toBe(2_870);
    expect(result.warnings.some((warning) => warning.includes("token usage"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("verifier reward"))).toBe(true);

    const run = store.benchmarks.getRun(result.runId);
    expect(run?.status).toBe("partial");
    expect(store.benchmarks.getDataset(run?.datasetId ?? "")?.taskCount).toBe(5);
    expect(store.benchmarks.listTrials(result.runId)).toHaveLength(5);

    const parseTrial = store.benchmarks.listTrials(result.runId).find((trial) => trial.trialKey === "parse-json__def456");
    expect(parseTrial?.reward).toBe(0);
    expect(parseTrial?.status).toBe("failed");
    expect(parseTrial?.rewardPath).toBe("verifier/reward.txt");
    expect(parseTrial?.attempt).toBe(2);

    const rewardJsonTrial = store.benchmarks.listTrials(result.runId).find((trial) => trial.trialKey === "reward-json__mno345");
    expect(rewardJsonTrial?.reward).toBe(1);
    expect(rewardJsonTrial?.status).toBe("passed");
    expect(rewardJsonTrial?.rewardPath).toBe("verifier/reward.json");
    expect(rewardJsonTrial?.resultPath).toBeNull();

    const missingTrial = store.benchmarks.listTrials(result.runId).find((trial) => trial.trialKey === "missing-reward__ghi789");
    expect(missingTrial?.reward).toBeNull();
    expect(missingTrial?.status).toBe("error");
    expect(missingTrial?.errorCode).toBe("REWARD_MISSING");

    const timeoutTrial = store.benchmarks.listTrials(result.runId).find((trial) => trial.trialKey === "timeout__jkl012");
    expect(timeoutTrial?.status).toBe("timeout");
    expect(timeoutTrial?.errorMessage).toContain("timed out");
    store.close();
  });

  it("is idempotent and returns a stable run id", () => {
    const store = new EvalStore(":memory:");
    const first = importMini(store);
    const second = importMini(store);
    expect(second.runId).toBe(first.runId);
    expect(store.benchmarks.listRuns()).toHaveLength(1);
    expect(store.benchmarks.listTrials(first.runId)).toHaveLength(5);
    expect(buildBenchmarkRunId({
      datasetId: first.datasetId,
      jobId: first.jobId,
      harnessName: "hearth-native",
      harnessVersion: "0.1.0",
      model: "test-model"
    })).toBe(first.runId);
    store.close();
  });

  it("supports dry run without writing", () => {
    const store = new EvalStore(":memory:");
    const result = importHarborJob({
      store,
      jobsRoot: fixtureRoot,
      input: { jobDir: "harbor-job-mini", dryRun: true },
      now: () => new Date("2026-11-20T12:00:00.000Z")
    });
    expect(result.dryRun).toBe(true);
    expect(result.trialCount).toBe(5);
    expect(store.benchmarks.listRuns()).toHaveLength(0);
    store.close();
  });

  it("rejects missing jobs and path escapes", () => {
    const store = new EvalStore(":memory:");
    expect(() => importMini(store, "missing-job")).toThrow(BenchmarkImportError);
    const outside = mkdtempSync(join(tmpdir(), "hearth-harbor-outside-"));
    try {
      importHarborJob({
        store,
        jobsRoot: fixtureRoot,
        input: { jobDir: outside }
      });
      throw new Error("expected import to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BenchmarkImportError);
      expect((error as BenchmarkImportError).code).toBe("JOB_OUTSIDE_ROOT");
    }
    store.close();
  });

  it("lists job candidates and their trial counts", () => {
    const candidates = listHarborJobCandidates(fixtureRoot);
    const names = candidates.jobs.map((job) => job.name);
    expect(names).toContain("harbor-job-mini");
    expect(names).toContain("harbor-job-mini-alt");
    expect(candidates.jobs.find((job) => job.name === "harbor-job-mini")?.trialCount).toBe(5);
  });
});
