export const BENCHMARK_TRIAL_STATUSES = [
  "passed",
  "failed",
  "partial",
  "error",
  "timeout",
  "budget_exceeded",
  "skipped"
] as const;
export type BenchmarkTrialStatus = (typeof BENCHMARK_TRIAL_STATUSES)[number];

export const BENCHMARK_RUN_STATUSES = ["imported", "partial", "error"] as const;
export type BenchmarkRunStatus = (typeof BENCHMARK_RUN_STATUSES)[number];

export const BENCHMARK_TASK_STATUSES = [
  "passed",
  "failed",
  "partial",
  "error",
  "timeout",
  "budget_exceeded"
] as const;
export type BenchmarkTaskStatus = (typeof BENCHMARK_TASK_STATUSES)[number];

export interface BenchmarkPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedPerMillionUsd?: number | undefined;
}

export interface BenchmarkDataset {
  id: string;
  name: string;
  version: string;
  source: string;
  commitSha: string | null;
  digest: string | null;
  taskCount: number;
  createdAt: string;
}

export interface BenchmarkTask {
  id: string;
  datasetId: string;
  taskKey: string;
  instructionPath: string | null;
  imageRef: string | null;
  timeoutSec: number | null;
  metadata: Record<string, unknown>;
}

export interface BenchmarkRun {
  id: string;
  datasetId: string;
  jobId: string;
  harnessName: string;
  harnessVersion: string;
  model: string;
  status: BenchmarkRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  config: Record<string, unknown>;
  rawDir: string;
  summary: BenchmarkRunSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface BenchmarkTrial {
  id: string;
  runId: string;
  taskId: string;
  taskKey: string;
  trialKey: string;
  attempt: number;
  reward: number | null;
  status: BenchmarkTrialStatus;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  rewardPath: string | null;
  resultPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  verifierStdout: string | null;
  verifierStderr: string | null;
  raw: unknown;
  createdAt: string;
}

export interface BenchmarkWilsonInterval {
  lower: number;
  upper: number;
}

export interface BenchmarkRunSummary {
  totalTasks: number;
  totalTrials: number;
  validTrials: number;
  passedTrials: number;
  failedTrials: number;
  partialTrials: number;
  errorTrials: number;
  timeoutTrials: number;
  budgetExceededTrials: number;
  skippedTrials: number;
  meanReward: number | null;
  passRate: number | null;
  passAt5: number | null;
  passAt5TaskCount: number;
  resolvedTasks: number;
  partialTasks: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costKnownTrials: number;
  costPerSolvedUsd: number | null;
  avgDurationMs: number | null;
  infraErrorRate: number;
  wilson95: BenchmarkWilsonInterval | null;
}

export interface BenchmarkTaskSummary {
  taskKey: string;
  attempts: number;
  validAttempts: number;
  passedAttempts: number;
  bestReward: number | null;
  meanReward: number | null;
  status: BenchmarkTaskStatus;
  totalTokens: number;
  costUsd: number | null;
  avgDurationMs: number | null;
}

export interface BenchmarkCompareTask {
  taskKey: string;
  baselineBestReward: number | null;
  candidateBestReward: number | null;
  baselineMeanReward: number | null;
  candidateMeanReward: number | null;
  rewardDelta: number | null;
  baselineTokens: number;
  candidateTokens: number;
  tokenDelta: number;
  baselineAttempts: number;
  candidateAttempts: number;
  status: "improved" | "regressed" | "unchanged" | "added" | "missing";
}

export interface BenchmarkCompareAggregate {
  baseline: BenchmarkRunSummary;
  candidate: BenchmarkRunSummary;
  meanRewardDelta: number | null;
  passAt5Delta: number | null;
  tokenDelta: number;
  costDelta: number | null;
  resolvedTaskDelta: number;
}

export interface BenchmarkCompareResult {
  baselineRunId: string;
  candidateRunId: string;
  aggregate: BenchmarkCompareAggregate;
  tasks: BenchmarkCompareTask[];
  warnings: string[];
}

export interface BenchmarkJobCandidate {
  name: string;
  path: string;
  modifiedAt: string;
  hasConfig: boolean;
  hasResult: boolean;
  trialCount: number;
}

export interface BenchmarkImportInput {
  jobDir: string;
  datasetName?: string | undefined;
  datasetVersion?: string | undefined;
  datasetCommitSha?: string | undefined;
  datasetDigest?: string | undefined;
  datasetTaskCount?: number | undefined;
  harnessName?: string | undefined;
  harnessVersion?: string | undefined;
  model?: string | undefined;
  pricing?: BenchmarkPricing | undefined;
  dryRun?: boolean | undefined;
}

export interface BenchmarkImportResult {
  runId: string;
  jobId: string;
  datasetId: string;
  dryRun: boolean;
  trialCount: number;
  taskCount: number;
  summary: BenchmarkRunSummary;
  warnings: string[];
}

export interface BenchmarkImportDatasetInput {
  id: string;
  name: string;
  version: string;
  source: string;
  commitSha: string | null;
  digest: string | null;
  taskCount: number;
  createdAt: string;
}

export interface BenchmarkImportRunInput {
  id: string;
  datasetId: string;
  jobId: string;
  harnessName: string;
  harnessVersion: string;
  model: string;
  status: BenchmarkRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  config: Record<string, unknown>;
  rawDir: string;
  createdAt: string;
  updatedAt: string;
}

export interface BenchmarkTrialFilter {
  taskKey?: string | undefined;
  status?: BenchmarkTrialStatus | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTrialStatus(input: {
  reward: number | null;
  exceptionType?: string | null;
  exceptionMessage?: string | null;
  hearthStatus?: string | null;
}): BenchmarkTrialStatus {
  if (input.hearthStatus === "budget_exceeded") return "budget_exceeded";
  const exception = `${input.exceptionType ?? ""} ${input.exceptionMessage ?? ""}`.toLowerCase();
  if (exception.includes("timeout") || exception.includes("timed out") || exception.includes("deadline")) {
    return "timeout";
  }
  if (exception.trim().length > 0) return "error";
  if (input.reward === null) return "error";
  if (input.reward >= 1) return "passed";
  if (input.reward <= 0) return "failed";
  return "partial";
}

export function computeTrialCost(
  tokens: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null },
  pricing: BenchmarkPricing | null | undefined
): number | null {
  if (!pricing) return null;
  const input = tokens.inputTokens ?? 0;
  const output = tokens.outputTokens ?? 0;
  const cached = tokens.cachedTokens ?? 0;
  const cachedPrice = pricing.cachedPerMillionUsd ?? pricing.inputPerMillionUsd;
  const cost = (input / 1_000_000) * pricing.inputPerMillionUsd
    + (output / 1_000_000) * pricing.outputPerMillionUsd
    + (cached / 1_000_000) * cachedPrice;
  return Number.isFinite(cost) ? cost : null;
}

export function wilsonInterval(successes: number, total: number, z = 1.96): BenchmarkWilsonInterval | null {
  if (total <= 0) return null;
  const clampedSuccesses = Math.max(0, Math.min(total, successes));
  const p = clampedSuccesses / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin)
  };
}

export function summarizeBenchmarkTrials(
  trials: BenchmarkTrial[],
  pricing?: BenchmarkPricing | null
): BenchmarkRunSummary {
  let validTrials = 0;
  let passedTrials = 0;
  let failedTrials = 0;
  let partialTrials = 0;
  let errorTrials = 0;
  let timeoutTrials = 0;
  let budgetExceededTrials = 0;
  let skippedTrials = 0;
  let rewardSum = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costSum = 0;
  let costKnownTrials = 0;
  let durationSum = 0;
  let durationCount = 0;
  const taskKeys = new Set<string>();

  for (const trial of trials) {
    taskKeys.add(trial.taskKey);
    inputTokens += trial.inputTokens ?? 0;
    outputTokens += trial.outputTokens ?? 0;
    cachedTokens += trial.cachedTokens ?? 0;
    const cost = trial.costUsd ?? computeTrialCost(trial, pricing);
    if (cost !== null) {
      costSum += cost;
      costKnownTrials += 1;
    }
    if (trial.durationMs !== null) {
      durationSum += trial.durationMs;
      durationCount += 1;
    }
    if (trial.reward !== null && Number.isFinite(trial.reward)) {
      validTrials += 1;
      rewardSum += trial.reward;
      if (trial.reward >= 1) passedTrials += 1;
      else if (trial.reward <= 0) failedTrials += 1;
      else partialTrials += 1;
    }
    if (trial.status === "error") errorTrials += 1;
    else if (trial.status === "timeout") timeoutTrials += 1;
    else if (trial.status === "budget_exceeded") budgetExceededTrials += 1;
    else if (trial.status === "skipped") skippedTrials += 1;
  }

  const taskSummaries = summarizeBenchmarkTasks(trials);
  const resolvedTasks = taskSummaries.filter((task) => task.bestReward !== null && task.bestReward >= 1).length;
  const partialTasks = taskSummaries.filter((task) => task.bestReward !== null && task.bestReward > 0 && task.bestReward < 1).length;
  const tasksWithFive = taskSummaries.filter((task) => task.validAttempts >= 5);
  const passAt5TaskCount = tasksWithFive.length;
  const passAt5Successes = tasksWithFive.filter((task) => task.bestReward !== null && task.bestReward >= 1).length;
  const totalTrials = trials.length;
  const meanReward = validTrials > 0 ? rewardSum / validTrials : null;
  const passRate = validTrials > 0 ? passedTrials / validTrials : null;
  const costUsd = costKnownTrials > 0 ? costSum : null;
  const costPerSolvedUsd = costUsd !== null && resolvedTasks > 0 ? costUsd / resolvedTasks : null;
  const infraErrors = errorTrials + timeoutTrials + budgetExceededTrials;
  const wilson95 = validTrials > 0 ? wilsonInterval(passedTrials, validTrials) : null;

  return {
    totalTasks: taskKeys.size,
    totalTrials,
    validTrials,
    passedTrials,
    failedTrials,
    partialTrials,
    errorTrials,
    timeoutTrials,
    budgetExceededTrials,
    skippedTrials,
    meanReward,
    passRate,
    passAt5: passAt5TaskCount > 0 ? passAt5Successes / passAt5TaskCount : null,
    passAt5TaskCount,
    resolvedTasks,
    partialTasks,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    costKnownTrials,
    costPerSolvedUsd,
    avgDurationMs: durationCount > 0 ? durationSum / durationCount : null,
    infraErrorRate: totalTrials > 0 ? infraErrors / totalTrials : 0,
    wilson95
  };
}

function taskStatusFromTrials(trials: BenchmarkTrial[], bestReward: number | null, validAttempts: number): BenchmarkTaskStatus {
  if (bestReward !== null && bestReward >= 1) return "passed";
  if (bestReward !== null && bestReward > 0) return "partial";
  if (validAttempts > 0) return "failed";
  if (trials.some((trial) => trial.status === "timeout")) return "timeout";
  if (trials.some((trial) => trial.status === "budget_exceeded")) return "budget_exceeded";
  return "error";
}

export function summarizeBenchmarkTasks(trials: BenchmarkTrial[]): BenchmarkTaskSummary[] {
  const grouped = new Map<string, BenchmarkTrial[]>();
  for (const trial of trials) {
    const list = grouped.get(trial.taskKey) ?? [];
    list.push(trial);
    grouped.set(trial.taskKey, list);
  }

  const summaries: BenchmarkTaskSummary[] = [];
  for (const [taskKey, taskTrials] of grouped) {
    let validAttempts = 0;
    let passedAttempts = 0;
    let rewardSum = 0;
    let bestReward: number | null = null;
    let totalTokens = 0;
    let costSum = 0;
    let costCount = 0;
    let durationSum = 0;
    let durationCount = 0;

    for (const trial of taskTrials) {
      totalTokens += (trial.inputTokens ?? 0) + (trial.outputTokens ?? 0);
      if (trial.costUsd !== null) {
        costSum += trial.costUsd;
        costCount += 1;
      }
      if (trial.durationMs !== null) {
        durationSum += trial.durationMs;
        durationCount += 1;
      }
      if (trial.reward !== null && Number.isFinite(trial.reward)) {
        validAttempts += 1;
        rewardSum += trial.reward;
        bestReward = bestReward === null ? trial.reward : Math.max(bestReward, trial.reward);
        if (trial.reward >= 1) passedAttempts += 1;
      }
    }

    summaries.push({
      taskKey,
      attempts: taskTrials.length,
      validAttempts,
      passedAttempts,
      bestReward,
      meanReward: validAttempts > 0 ? rewardSum / validAttempts : null,
      status: taskStatusFromTrials(taskTrials, bestReward, validAttempts),
      totalTokens,
      costUsd: costCount > 0 ? costSum : null,
      avgDurationMs: durationCount > 0 ? durationSum / durationCount : null
    });
  }

  return summaries.sort((a, b) => a.taskKey.localeCompare(b.taskKey));
}

function rewardDelta(baseline: number | null, candidate: number | null): number | null {
  if (baseline === null || candidate === null) return null;
  return candidate - baseline;
}

export function compareBenchmarkTrials(
  baselineRunId: string,
  candidateRunId: string,
  baselineTrials: BenchmarkTrial[],
  candidateTrials: BenchmarkTrial[],
  modelMismatch = false
): BenchmarkCompareResult {
  const baselineSummary = summarizeBenchmarkTrials(baselineTrials);
  const candidateSummary = summarizeBenchmarkTrials(candidateTrials);
  const baselineTasks = new Map(summarizeBenchmarkTasks(baselineTrials).map((task) => [task.taskKey, task]));
  const candidateTasks = new Map(summarizeBenchmarkTasks(candidateTrials).map((task) => [task.taskKey, task]));
  const taskKeys = new Set([...baselineTasks.keys(), ...candidateTasks.keys()]);
  const tasks: BenchmarkCompareTask[] = [];

  for (const taskKey of taskKeys) {
    const baseline = baselineTasks.get(taskKey);
    const candidate = candidateTasks.get(taskKey);
    const baselineBest = baseline?.bestReward ?? null;
    const candidateBest = candidate?.bestReward ?? null;
    let status: BenchmarkCompareTask["status"] = "unchanged";
    if (!baseline) status = "added";
    else if (!candidate) status = "missing";
    else if (baselineBest === null || candidateBest === null) status = "unchanged";
    else if (candidateBest > baselineBest) status = "improved";
    else if (candidateBest < baselineBest) status = "regressed";

    tasks.push({
      taskKey,
      baselineBestReward: baselineBest,
      candidateBestReward: candidateBest,
      baselineMeanReward: baseline?.meanReward ?? null,
      candidateMeanReward: candidate?.meanReward ?? null,
      rewardDelta: rewardDelta(baselineBest, candidateBest),
      baselineTokens: baseline?.totalTokens ?? 0,
      candidateTokens: candidate?.totalTokens ?? 0,
      tokenDelta: (candidate?.totalTokens ?? 0) - (baseline?.totalTokens ?? 0),
      baselineAttempts: baseline?.attempts ?? 0,
      candidateAttempts: candidate?.attempts ?? 0,
      status
    });
  }

  tasks.sort((a, b) => a.taskKey.localeCompare(b.taskKey));
  const warnings: string[] = [];
  if (modelMismatch) warnings.push("Both runs use different models; compare harness behavior with caution.");

  return {
    baselineRunId,
    candidateRunId,
    aggregate: {
      baseline: baselineSummary,
      candidate: candidateSummary,
      meanRewardDelta: rewardDelta(baselineSummary.meanReward, candidateSummary.meanReward),
      passAt5Delta: rewardDelta(baselineSummary.passAt5, candidateSummary.passAt5),
      tokenDelta: candidateSummary.totalTokens - baselineSummary.totalTokens,
      costDelta: baselineSummary.costUsd !== null && candidateSummary.costUsd !== null
        ? candidateSummary.costUsd - baselineSummary.costUsd
        : null,
      resolvedTaskDelta: candidateSummary.resolvedTasks - baselineSummary.resolvedTasks
    },
    tasks,
    warnings
  };
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll("\"", "\"\"")}"`;
  return text;
}

export function toBenchmarkCsv(trials: BenchmarkTrial[]): string {
  const header = [
    "run_id",
    "task_key",
    "trial_key",
    "attempt",
    "status",
    "reward",
    "duration_ms",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "cost_usd",
    "error_code",
    "error_message"
  ];
  const rows = trials.map((trial) => [
    trial.runId,
    trial.taskKey,
    trial.trialKey,
    trial.attempt,
    trial.status,
    trial.reward,
    trial.durationMs,
    trial.inputTokens,
    trial.outputTokens,
    trial.cachedTokens,
    trial.costUsd,
    trial.errorCode,
    trial.errorMessage
  ].map(csvCell).join(","));
  return `${header.join(",")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

export function benchmarkTaskStatusLabel(status: BenchmarkTaskStatus | BenchmarkTrialStatus | BenchmarkRunStatus): string {
  const labels: Record<string, string> = {
    passed: "通过",
    failed: "失败",
    partial: "部分通过",
    error: "错误",
    timeout: "超时",
    budget_exceeded: "预算耗尽",
    skipped: "跳过",
    imported: "已导入"
  };
  return labels[status] ?? status;
}

export function formatBenchmarkTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function benchmarkTrialTiming(trial: BenchmarkTrial): number | null {
  return trial.durationMs;
}

export function benchmarkTrialTimestamp(value: string | null): number | null {
  return parseTime(value);
}

export function benchmarkIntegerOrNull(value: unknown): number | null {
  return integerOrNull(value);
}
