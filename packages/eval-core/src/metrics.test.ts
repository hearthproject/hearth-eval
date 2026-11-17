import { describe, expect, it } from "vitest";
import { aggregateMetrics, computeMetrics, metricForCriterion } from "./metrics.ts";
import type { CaseManifest, EvalCriterion } from "./types.ts";

const manifest: CaseManifest = {
  schemaVersion: 2,
  id: "METRIC-01",
  version: 1,
  title: "指标测试",
  family: "operations",
  difficulty: "normal",
  runModes: ["offline"],
  description: "测试八项指标",
  goal: "验证指标聚合",
  tags: [],
  timeoutMs: 60_000,
  inputs: [{ kind: "file", label: "输入", path: "input.md" }],
  expectedOutputs: ["result.md"],
  graders: [{ id: "file", title: "文件", config: { kind: "file", path: "result.md" } }],
  criteria: [
    { id: "exists", label: "输出字段", source: "deterministic", points: 30, severity: "blocker", graderId: "file" },
    { id: "citations", label: "引用来源准确", source: "judge", points: 30, severity: "scored", rubric: "引用准确" },
    { id: "human", label: "人工复核", source: "human", points: 10, severity: "scored" }
  ],
  budgets: { maxDurationMs: 2_000, maxTokens: 1_000 },
  humanReview: { prompt: "检查", sampleRate: 0 }
};

describe("computeMetrics", () => {
  it("derives the eight metrics from criteria, gates and budgets", () => {
    const metrics = computeMetrics({
      manifest,
      verdict: "passed",
      deterministic: { exists: { passed: true, reason: "ok", evidence: [] } },
      judge: { criteria: { citations: { passed: true, confidence: 0.9, reason: "ok" } }, overallConfidence: 0.9 },
      humanDecision: null,
      gates: [{ id: "no-unsafe-write", layer: "safety", severity: "blocker", passed: false, reason: "写入了受限目录" }],
      observation: { steps: 4, toolCalls: 2, approvals: 1, effects: 1, errors: 0, durationMs: 3_000, tokens: 500 }
    });
    expect(metrics.task_success.score).toBe(100);
    expect(metrics.arguments.score).toBe(100);
    expect(metrics.knowledge_grounding.score).toBe(100);
    expect(metrics.security.score).toBe(0);
    expect(metrics.latency).toMatchObject({ score: 66.67, sampleSize: 1 });
    expect(metrics.cost).toMatchObject({ score: 100, sampleSize: 1 });
    expect(metrics.tool_selection.score).toBeNull();
  });

  it("uses the task timeout as a latency budget fallback", () => {
    const noBudgetManifest = { ...manifest };
    delete noBudgetManifest.budgets;
    const metrics = computeMetrics({
      manifest: noBudgetManifest,
      verdict: "failed",
      deterministic: { exists: { passed: false, reason: "missing", evidence: [] } },
      judge: null,
      humanDecision: null,
      gates: [],
      observation: { steps: 1, toolCalls: 0, approvals: 0, effects: 0, errors: 0, durationMs: 30_000, tokens: null }
    });
    expect(metrics.task_success.score).toBe(0);
    expect(metrics.latency.score).toBe(100);
    expect(metrics.cost.score).toBeNull();
  });

  it("requires review when the verdict is undecided", () => {
    const metrics = computeMetrics({
      manifest,
      verdict: "needs_review",
      deterministic: { exists: { passed: true, reason: "ok", evidence: [] } },
      judge: null,
      humanDecision: "unknown",
      gates: [],
      observation: null
    });
    expect(metrics.task_success).toMatchObject({ score: null, detail: "等待复核结论" });
    expect(metrics.latency.score).toBeNull();
  });
});

describe("metricForCriterion", () => {
  it.each([
    [{ id: "privacy", label: "隐私冲突", source: "deterministic" }, "security"],
    [{ id: "retry", label: "失败恢复", source: "deterministic" }, "recovery"],
    [{ id: "tool", label: "工具选择", source: "judge" }, "tool_selection"],
    [{ id: "facts", label: "事实依据", source: "judge" }, "knowledge_grounding"],
    [{ id: "output_fields", label: "字段内容正确", source: "deterministic" }, "arguments"],
    [{ id: "quality", label: "表达质量", source: "judge" }, null]
  ] as Array<[EvalCriterion, string | null]>)("infers %#", (criterion, expected) => {
    expect(metricForCriterion(criterion)).toBe(expected);
  });
});

describe("aggregateMetrics", () => {
  it("averages available scores and ignores missing evidence", () => {
    const base = computeMetrics({
      manifest,
      verdict: "passed",
      deterministic: { exists: { passed: true, reason: "ok", evidence: [] } },
      judge: null,
      humanDecision: null,
      gates: [],
      observation: null
    });
    const failed = { ...base, task_success: { ...base.task_success, score: 0 } };
    const aggregated = aggregateMetrics([
      Object.values(base),
      Object.values(failed),
      Object.values({ ...base, task_success: { ...base.task_success, score: null } })
    ]);
    expect(aggregated.find((item) => item.key === "task_success")).toMatchObject({ score: 50, sampleSize: 2 });
    expect(aggregated.find((item) => item.key === "security")?.score).toBeNull();
  });
});
