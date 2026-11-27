// CI regression budget and stable-subset selection.
import type { CaseVersionSummary } from "./types.ts";
import { wilsonInterval } from "./benchmark.ts";

export interface RegressionGateConfig {
  maxPassRateDropPct: number;
  maxCostIncreasePct: number;
  maxP95LatencyIncreasePct: number;
  maxSafetyBlockers: number;
  maxUnexpectedNondeterminism: number;
  requireNewFailuresFixed: boolean;
  requireManifestDiffOnCriticalChange: boolean;
}

export const DEFAULT_REGRESSION_GATE: RegressionGateConfig = {
  maxPassRateDropPct: 2,
  maxCostIncreasePct: 10,
  maxP95LatencyIncreasePct: 15,
  maxSafetyBlockers: 0,
  maxUnexpectedNondeterminism: 0,
  requireNewFailuresFixed: true,
  requireManifestDiffOnCriticalChange: true
};

export interface RegressionStats {
  experimentId: string;
  totalRuns: number;
  passed: number;
  passRate: number | null;
  costPerVerifiedCompletion: number | null;
  p95LatencyMs: number | null;
  safetyBlockers: number;
  unexpectedNondeterminism: number;
  failedCaseIds: string[];
  manifestChangedComponents: string[];
  pricingSnapshotIds?: string[];
}

export interface RegressionGateFinding {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  baseline: number | string | null;
  candidate: number | string | null;
  delta: number | null;
}

export interface RegressionGateReport {
  baselineExperimentId: string;
  candidateExperimentId: string;
  verdict: "pass" | "block" | "warn";
  blockers: RegressionGateFinding[];
  warnings: RegressionGateFinding[];
  intervallOverlap: boolean;
  generatedAt: string;
}

function percentChange(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null) return null;
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return (candidate - baseline) / baseline * 100;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index] ?? null;
}

export function regressionStatsFromRuns(input: {
  experimentId: string;
  runs: Array<{
    status: string;
    caseId: string;
    durationMs: number | null;
    costUsd: number | null;
    safetyBlocker?: boolean;
    nondeterministic?: boolean;
    manifestChanged?: boolean;
  }>;
  pricingSnapshotIds?: string[];
}): RegressionStats {
  const total = input.runs.length;
  const passed = input.runs.filter((run) => run.status === "passed").length;
  const durations = input.runs.flatMap((run) => run.durationMs === null ? [] : [run.durationMs]);
  const priced = input.runs.filter((run) => run.costUsd !== null);
  const totalUsd = priced.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  return {
    experimentId: input.experimentId,
    totalRuns: total,
    passed,
    passRate: total === 0 ? null : passed / total * 100,
    costPerVerifiedCompletion: passed > 0 && priced.length > 0 ? totalUsd / passed : null,
    p95LatencyMs: p95(durations),
    safetyBlockers: input.runs.filter((run) => run.safetyBlocker).length,
    unexpectedNondeterminism: input.runs.filter((run) => run.nondeterministic).length,
    failedCaseIds: [...new Set(input.runs.filter((run) => run.status !== "passed").map((run) => run.caseId))],
    manifestChangedComponents: [...new Set(input.runs.filter((run) => run.manifestChanged).map((run) => run.caseId))],
    pricingSnapshotIds: input.pricingSnapshotIds ?? []
  };
}

export function evaluateRegressionGate(
  baseline: RegressionStats,
  candidate: RegressionStats,
  config: RegressionGateConfig = DEFAULT_REGRESSION_GATE,
  now: Date = new Date()
): RegressionGateReport {
  const blockers: RegressionGateFinding[] = [];
  const warnings: RegressionGateFinding[] = [];

  if (baseline.passRate !== null && candidate.passRate !== null) {
    const delta = candidate.passRate - baseline.passRate;
    if (delta < -config.maxPassRateDropPct) {
      blockers.push({
        code: "regression.pass_rate",
        severity: "blocker",
        message: `通过率下降 ${Math.abs(delta).toFixed(2)} 个百分点，超过 ${config.maxPassRateDropPct}`,
        baseline: baseline.passRate,
        candidate: candidate.passRate,
        delta
      });
    }
  }

  const costDelta = percentChange(baseline.costPerVerifiedCompletion, candidate.costPerVerifiedCompletion);
  if (costDelta !== null && costDelta > config.maxCostIncreasePct) {
    blockers.push({
      code: "regression.cost",
      severity: "blocker",
      message: `单次验证完成成本上升 ${costDelta.toFixed(1)}%，超过 ${config.maxCostIncreasePct}%`,
      baseline: baseline.costPerVerifiedCompletion,
      candidate: candidate.costPerVerifiedCompletion,
      delta: costDelta
    });
  }

  const latencyDelta = percentChange(baseline.p95LatencyMs, candidate.p95LatencyMs);
  if (latencyDelta !== null && latencyDelta > config.maxP95LatencyIncreasePct) {
    blockers.push({
      code: "regression.latency_p95",
      severity: "blocker",
      message: `p95 延迟上升 ${latencyDelta.toFixed(1)}%，超过 ${config.maxP95LatencyIncreasePct}%`,
      baseline: baseline.p95LatencyMs,
      candidate: candidate.p95LatencyMs,
      delta: latencyDelta
    });
  }

  if (candidate.safetyBlockers > config.maxSafetyBlockers) {
    blockers.push({
      code: "regression.safety_blockers",
      severity: "blocker",
      message: `安全 blocker ${candidate.safetyBlockers} 个，预算 ${config.maxSafetyBlockers}`,
      baseline: baseline.safetyBlockers,
      candidate: candidate.safetyBlockers,
      delta: candidate.safetyBlockers - baseline.safetyBlockers
    });
  }

  if (candidate.unexpectedNondeterminism > config.maxUnexpectedNondeterminism) {
    blockers.push({
      code: "regression.nondeterminism",
      severity: "blocker",
      message: `非预期不确定性 ${candidate.unexpectedNondeterminism} 次`,
      baseline: baseline.unexpectedNondeterminism,
      candidate: candidate.unexpectedNondeterminism,
      delta: candidate.unexpectedNondeterminism - baseline.unexpectedNondeterminism
    });
  }

  if (config.requireNewFailuresFixed) {
    const newFailures = candidate.failedCaseIds.filter((id) => !baseline.failedCaseIds.includes(id));
    if (newFailures.length > 0) {
      blockers.push({
        code: "regression.new_failures",
        severity: "blocker",
        message: `新增失败 Case 未修复：${newFailures.join(", ")}`,
        baseline: baseline.failedCaseIds.join(","),
        candidate: candidate.failedCaseIds.join(","),
        delta: newFailures.length
      });
    }
  }

  if (config.requireManifestDiffOnCriticalChange && candidate.manifestChangedComponents.length > 0) {
    warnings.push({
      code: "regression.manifest_diff",
      severity: "warning",
      message: `关键组件发生变化，需展示 Manifest diff：${candidate.manifestChangedComponents.join(", ")}`,
      baseline: null,
      candidate: candidate.manifestChangedComponents.join(","),
      delta: null
    });
  }

  const left = wilsonInterval(baseline.passed, baseline.totalRuns);
  const right = wilsonInterval(candidate.passed, candidate.totalRuns);
  const overlap = left !== null && right !== null
    ? left.lower <= right.upper && right.lower <= left.upper
    : true;
  if (!overlap && candidate.passRate !== null && baseline.passRate !== null && candidate.passRate < baseline.passRate) {
    warnings.push({
      code: "regression.wilson_gap",
      severity: "warning",
      message: "两次实验的 Wilson 区间不重叠，下降可能不是统计噪声",
      baseline: baseline.passRate,
      candidate: candidate.passRate,
      delta: candidate.passRate - baseline.passRate
    });
  }

  return {
    baselineExperimentId: baseline.experimentId,
    candidateExperimentId: candidate.experimentId,
    verdict: blockers.length > 0 ? "block" : warnings.length > 0 ? "warn" : "pass",
    blockers,
    warnings,
    intervallOverlap: overlap,
    generatedAt: now.toISOString()
  };
}

/**
 * Stable subset: cases whose historical runs show a consistent outcome.
 * Flaky cases are excluded from blocking CI and kept in a watch list.
 */
export function selectStableSubset(
  cases: CaseVersionSummary[],
  history: Array<{ caseKey: string; passed: boolean }>,
  options: { maxSubset?: number; minRuns?: number } = {}
): { stable: CaseVersionSummary[]; flaky: CaseVersionSummary[] } {
  const minRuns = options.minRuns ?? 3;
  const byCase = new Map<string, { pass: number; total: number }>();
  for (const item of history) {
    const entry = byCase.get(item.caseKey) ?? { pass: 0, total: 0 };
    entry.total += 1;
    if (item.passed) entry.pass += 1;
    byCase.set(item.caseKey, entry);
  }
  const stable: CaseVersionSummary[] = [];
  const flaky: CaseVersionSummary[] = [];
  for (const item of cases) {
    const entry = byCase.get(item.caseKey);
    if (!entry || entry.total < minRuns || entry.pass === 0 || entry.pass === entry.total) {
      if (entry && entry.total >= minRuns && (entry.pass === 0 || entry.pass === entry.total)) stable.push(item);
      else flaky.push(item);
    } else {
      flaky.push(item);
    }
  }
  const max = options.maxSubset ?? stable.length;
  return { stable: stable.slice(0, max), flaky };
}
