import { describe, expect, it } from "vitest";
import type { BenchmarkTrial } from "./benchmark.ts";
import {
  compareBenchmarkTrials,
  computeTrialCost,
  normalizeTrialStatus,
  summarizeBenchmarkTasks,
  summarizeBenchmarkTrials,
  toBenchmarkCsv,
  wilsonInterval
} from "./benchmark.ts";

let sequence = 0;
function trial(overrides: Partial<BenchmarkTrial> = {}): BenchmarkTrial {
  sequence += 1;
  return {
    id: `bt-${sequence}`,
    runId: "br-1",
    taskId: `task-${overrides.taskKey ?? "task-a"}`,
    taskKey: overrides.taskKey ?? "task-a",
    trialKey: overrides.trialKey ?? `trial-${sequence}`,
    attempt: overrides.attempt ?? 1,
    reward: overrides.reward ?? null,
    status: overrides.status ?? "error",
    durationMs: overrides.durationMs ?? null,
    inputTokens: overrides.inputTokens ?? null,
    outputTokens: overrides.outputTokens ?? null,
    cachedTokens: overrides.cachedTokens ?? null,
    costUsd: overrides.costUsd ?? null,
    rewardPath: overrides.rewardPath ?? null,
    resultPath: overrides.resultPath ?? null,
    errorCode: overrides.errorCode ?? null,
    errorMessage: overrides.errorMessage ?? null,
    verifierStdout: overrides.verifierStdout ?? null,
    verifierStderr: overrides.verifierStderr ?? null,
    raw: overrides.raw ?? null,
    createdAt: overrides.createdAt ?? "2026-11-20T00:00:00.000Z"
  };
}

describe("normalizeTrialStatus", () => {
  it("maps rewards and infrastructure exceptions", () => {
    expect(normalizeTrialStatus({ reward: 1 })).toBe("passed");
    expect(normalizeTrialStatus({ reward: 0 })).toBe("failed");
    expect(normalizeTrialStatus({ reward: 0.5 })).toBe("partial");
    expect(normalizeTrialStatus({ reward: null })).toBe("error");
    expect(normalizeTrialStatus({ reward: 0, exceptionType: "AgentTimeoutError" })).toBe("timeout");
    expect(normalizeTrialStatus({ reward: 1, hearthStatus: "budget_exceeded" })).toBe("budget_exceeded");
  });
});

describe("summarizeBenchmarkTrials", () => {
  it("computes mean reward, resolved tasks, and pass@5 only when five attempts exist", () => {
    const trials: BenchmarkTrial[] = [];
    for (let index = 0; index < 5; index += 1) {
      trials.push(trial({ taskKey: "task-a", reward: 1, status: "passed", inputTokens: 100, outputTokens: 10 }));
      trials.push(trial({ taskKey: "task-b", reward: 0, status: "failed", inputTokens: 80, outputTokens: 8 }));
    }
    trials.push(trial({ taskKey: "task-c", reward: 1, status: "passed" }));

    const summary = summarizeBenchmarkTrials(trials);
    expect(summary.totalTasks).toBe(3);
    expect(summary.validTrials).toBe(11);
    expect(summary.passedTrials).toBe(6);
    expect(summary.failedTrials).toBe(5);
    expect(summary.resolvedTasks).toBe(2);
    expect(summary.passAt5TaskCount).toBe(2);
    expect(summary.passAt5).toBe(0.5);
    expect(summary.meanReward).toBeCloseTo(6 / 11);
    expect(summary.totalTokens).toBe(5 * 110 + 5 * 88);
    expect(summary.wilson95).not.toBeNull();
  });

  it("keeps pass@5 null when no task has five valid attempts", () => {
    const summary = summarizeBenchmarkTrials([
      trial({ taskKey: "task-a", reward: 1, status: "passed" }),
      trial({ taskKey: "task-b", reward: 0, status: "failed" })
    ]);
    expect(summary.passAt5).toBeNull();
    expect(summary.passAt5TaskCount).toBe(0);
  });

  it("separates missing-reward errors from failed trials", () => {
    const summary = summarizeBenchmarkTrials([
      trial({ taskKey: "task-a", reward: 0, status: "failed" }),
      trial({ taskKey: "task-b", reward: null, status: "error", errorCode: "REWARD_MISSING" })
    ]);
    expect(summary.validTrials).toBe(1);
    expect(summary.failedTrials).toBe(1);
    expect(summary.errorTrials).toBe(1);
    expect(summary.infraErrorRate).toBe(0.5);
  });

  it("computes cost from prices and uses known cost coverage", () => {
    const trials = [
      trial({
        reward: 1,
        status: "passed",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cachedTokens: 200_000
      }),
      trial({ reward: 0, status: "failed", inputTokens: 0, outputTokens: 0 })
    ];
    const summary = summarizeBenchmarkTrials(trials, {
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      cachedPerMillionUsd: 0.3
    });
    expect(summary.costUsd).toBeCloseTo(3 + 7.5 + 0.06);
    expect(summary.costKnownTrials).toBe(2);
    expect(summary.costPerSolvedUsd).toBeCloseTo(10.56);
  });
});

describe("summarizeBenchmarkTasks", () => {
  it("uses best reward and reports partial tasks", () => {
    const tasks = summarizeBenchmarkTasks([
      trial({ taskKey: "task-a", reward: 0, status: "failed" }),
      trial({ taskKey: "task-a", reward: 1, status: "passed" }),
      trial({ taskKey: "task-b", reward: 0.4, status: "partial" }),
      trial({ taskKey: "task-c", reward: null, status: "timeout", errorCode: "TIMEOUT" })
    ]);
    const byKey = new Map(tasks.map((task) => [task.taskKey, task]));
    expect(byKey.get("task-a")?.status).toBe("passed");
    expect(byKey.get("task-a")?.bestReward).toBe(1);
    expect(byKey.get("task-b")?.status).toBe("partial");
    expect(byKey.get("task-c")?.status).toBe("timeout");
  });
});

describe("wilsonInterval", () => {
  it("returns null for an empty sample and clamps boundaries", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(0, 5)?.lower).toBe(0);
    expect(wilsonInterval(5, 5)?.upper).toBe(1);
    const interval = wilsonInterval(3, 5);
    expect(interval?.lower).toBeGreaterThan(0);
    expect(interval?.upper).toBeLessThan(1);
  });
});

describe("compareBenchmarkTrials", () => {
  it("marks improvements, regressions, and missing tasks", () => {
    const baseline = [
      trial({ taskKey: "task-a", reward: 0, status: "failed" }),
      trial({ taskKey: "task-b", reward: 1, status: "passed" }),
      trial({ taskKey: "task-c", reward: 1, status: "passed" })
    ];
    const candidate = [
      trial({ taskKey: "task-a", reward: 1, status: "passed" }),
      trial({ taskKey: "task-b", reward: 0, status: "failed" }),
      trial({ taskKey: "task-d", reward: 1, status: "passed" })
    ];
    const result = compareBenchmarkTrials("baseline", "candidate", baseline, candidate, true);
    const byKey = new Map(result.tasks.map((task) => [task.taskKey, task]));
    expect(byKey.get("task-a")?.status).toBe("improved");
    expect(byKey.get("task-b")?.status).toBe("regressed");
    expect(byKey.get("task-c")?.status).toBe("missing");
    expect(byKey.get("task-d")?.status).toBe("added");
    expect(result.warnings).toHaveLength(1);
    expect(result.aggregate.resolvedTaskDelta).toBe(0);
  });
});

describe("toBenchmarkCsv", () => {
  it("escapes commas, quotes, and newlines", () => {
    const csv = toBenchmarkCsv([
      trial({
        taskKey: "task,with,commas",
        reward: 1,
        status: "passed",
        errorMessage: "line one\nline \"two\""
      })
    ]);
    expect(csv).toContain("task_key");
    expect(csv).toContain("\"task,with,commas\"");
    expect(csv).toContain("\"line one\nline \"\"two\"\"\"");
  });
});
