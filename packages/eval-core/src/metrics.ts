import type {
  BudgetLimits,
  CaseManifest,
  EvalCriterion,
  EvalMetricKey,
  MetricSummary,
  ScoringOutcome
} from "./types.ts";
import { EVAL_METRIC_KEYS } from "./types.ts";
import type { GraderOutcome, TraceObservation } from "./graders.ts";
import type { GateLayer } from "./types.ts";
import { round, type GateOutcomeInput, type JudgeOutcome } from "./scoring.ts";

export const METRIC_LABELS: Record<EvalMetricKey, string> = {
  task_success: "任务成功",
  tool_selection: "工具选择",
  recovery: "错误恢复",
  arguments: "参数正确",
  knowledge_grounding: "知识依据",
  latency: "时延",
  cost: "成本",
  security: "安全"
};

export interface MetricInput {
  manifest: CaseManifest;
  verdict: ScoringOutcome["verdict"];
  deterministic: Record<string, GraderOutcome>;
  judge: JudgeOutcome | null;
  humanDecision: "pass" | "fail" | "unknown" | null;
  gates: GateOutcomeInput[];
  observation: TraceObservation | null;
  timeoutMs?: number;
}

interface MetricCheck {
  metric: EvalMetricKey;
  passed: boolean | null;
  weight: number;
}

export function computeMetrics(input: MetricInput): Record<EvalMetricKey, MetricSummary> {
  const checks: MetricCheck[] = [];
  for (const criterion of input.manifest.criteria) {
    if ((criterion.layer ?? "result") !== "result") continue;
    const metric = metricForCriterion(criterion);
    if (!metric) continue;
    checks.push({
      metric,
      passed: outcomeForCriterion(criterion, input),
      weight: Math.max(1, criterion.points)
    });
  }
  for (const gate of input.gates) {
    const criterion = input.manifest.criteria.find((item) => item.id === gate.id);
    const metric = criterion ? metricForCriterion(criterion) ?? metricForLayer(criterion.layer ?? gate.layer) : metricForLayer(gate.layer);
    if (!metric) continue;
    checks.push({ metric, passed: gate.passed, weight: criterion ? Math.max(1, criterion.points) : 1 });
  }

  const result = {} as Record<EvalMetricKey, MetricSummary>;
  for (const key of EVAL_METRIC_KEYS) {
    const selected = checks.filter((check) => check.metric === key);
    const known = selected.filter((check) => check.passed !== null);
    const weight = known.reduce((sum, check) => sum + check.weight, 0);
    const earned = known.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);
    result[key] = {
      key,
      label: METRIC_LABELS[key],
      score: weight > 0 ? round(earned / weight * 100) : null,
      sampleSize: known.length,
      detail: selected.length === 0 ? "没有对应评分证据" : `${known.length} / ${selected.length} 项有明确结果`
    };
  }

  result.task_success = {
    key: "task_success",
    label: METRIC_LABELS.task_success,
    score: input.verdict === "passed" ? 100 : input.verdict === "failed" ? 0 : null,
    sampleSize: 1,
    detail: input.verdict === "needs_review" ? "等待复核结论" : `运行判定为 ${input.verdict}`
  };

  const budgets = input.manifest.budgets;
  result.latency = budgetMetric(
    "latency",
    input.observation?.durationMs ?? null,
    budgets?.maxDurationMs ?? input.timeoutMs ?? input.manifest.timeoutMs,
    "ms"
  );
  result.cost = budgetMetric("cost", input.observation?.tokens ?? null, budgets?.maxTokens, "tokens");
  return result;
}

export function metricSummaries(input: MetricInput): MetricSummary[] {
  const result = computeMetrics(input);
  return EVAL_METRIC_KEYS.map((key) => result[key]);
}

export function aggregateMetrics(samples: MetricSummary[][]): MetricSummary[] {
  return EVAL_METRIC_KEYS.map((key) => {
    const selected = samples.map((sample) => sample.find((item) => item.key === key)).filter((item): item is MetricSummary => Boolean(item));
    const scored = selected.filter((item) => item.score !== null);
    return {
      key,
      label: METRIC_LABELS[key],
      score: scored.length === 0 ? null : round(scored.reduce((sum, item) => sum + (item.score ?? 0), 0) / scored.length),
      sampleSize: scored.length,
      detail: scored.length === 0 ? "没有运行包含该指标证据" : `${scored.length} 次运行有该指标证据`
    };
  });
}

export function emptyMetrics(): MetricSummary[] {
  return EVAL_METRIC_KEYS.map((key) => ({
    key,
    label: METRIC_LABELS[key],
    score: null,
    sampleSize: 0,
    detail: "没有运行数据"
  }));
}

export function metricForCriterion(criterion: EvalCriterion): EvalMetricKey | null {
  if (criterion.metric) return criterion.metric;
  const text = `${criterion.id} ${criterion.label}`.toLowerCase();
  const keywords: Array<[EvalMetricKey, string[]]> = [
    ["security", ["security", "privacy", "unsafe", "injection", "phishing", "敏感", "隐私", "注入", "钓鱼", "安全", "泄露", "禁止", "不得"]],
    ["recovery", ["recover", "retry", "resume", "恢复", "重试", "续跑", "中断"]],
    ["tool_selection", ["tool", "mcp", "工具", "调用"]],
    ["knowledge_grounding", ["ground", "citation", "source", "evidence", "fact", "依据", "引用", "来源", "事实", "证据", "知识"]],
    ["arguments", ["argument", "parameter", "参数", "字段", "格式"]]
  ];
  for (const [metric, words] of keywords) {
    if (words.some((word) => text.includes(word))) return metric;
  }
  if (criterion.source === "deterministic") return "arguments";
  return null;
}

function outcomeForCriterion(criterion: EvalCriterion, input: MetricInput): boolean | null {
  if (criterion.source === "deterministic") return input.deterministic[criterion.id]?.passed ?? null;
  if (criterion.source === "judge") return input.judge?.criteria[criterion.id]?.passed ?? null;
  return input.humanDecision === "pass" ? true : input.humanDecision === "fail" ? false : null;
}

function metricForLayer(layer: GateLayer): EvalMetricKey | null {
  if (layer === "safety") return "security";
  if (layer === "knowledge") return "knowledge_grounding";
  if (layer === "trajectory") return "tool_selection";
  if (layer === "action") return "recovery";
  return null;
}

function budgetMetric(key: "latency" | "cost", value: number | null, limit: number | undefined, unit: string): MetricSummary {
  if (value === null) {
    return { key, label: METRIC_LABELS[key], score: null, sampleSize: 0, detail: "没有观测值" };
  }
  if (limit === undefined || limit <= 0) {
    return { key, label: METRIC_LABELS[key], score: null, sampleSize: 0, detail: `观测值 ${value} ${unit}，未设置预算` };
  }
  const score = value <= limit ? 100 : round(limit / value * 100);
  return {
    key,
    label: METRIC_LABELS[key],
    score,
    sampleSize: 1,
    detail: `${value} ${unit} / 上限 ${limit} ${unit}`
  };
}
