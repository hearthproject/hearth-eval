// Harness / Context Policy Lab statistics.
//
// Two variants are only comparable when case, model and judge are fixed. We
// align runs by case + repetition, then report paired pass-rate, cost and
// latency deltas with bootstrap confidence intervals. The bootstrap RNG is
// seeded so a report can be reproduced exactly.
import { wilsonInterval } from "./benchmark.ts";
import type { VariantExperimentSummary } from "./types.ts";

export interface PairedRun {
  caseKey: string;
  repetition: number;
  passed: boolean;
  score: number | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface BootstrapInterval {
  lower: number;
  upper: number;
  confidence: number;
  iterations: number;
  seed: number;
}

export interface PairedComparison {
  alignedPairs: number;
  left: VariantExperimentSummary;
  right: VariantExperimentSummary;
  passRateDelta: BootstrapInterval | null;
  costDeltaUsd: BootstrapInterval | null;
  latencyDeltaMs: BootstrapInterval | null;
  scoreDelta: BootstrapInterval | null;
  direction: "better" | "worse" | "same" | "inconclusive";
  warnings: string[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMean(
  values: number[],
  options: { iterations?: number | undefined; confidence?: number | undefined; seed?: number | undefined } = {}
): BootstrapInterval | null {
  if (values.length === 0) return null;
  const iterations = options.iterations ?? 2000;
  const confidence = options.confidence ?? 0.95;
  const seed = options.seed ?? 20261127;
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    let sum = 0;
    for (let sample = 0; sample < values.length; sample += 1) {
      sum += values[Math.floor(random() * values.length)] ?? 0;
    }
    means.push(sum / values.length);
  }
  means.sort((left, right) => left - right);
  const lowerIndex = Math.floor((1 - confidence) / 2 * iterations);
  const upperIndex = Math.min(iterations - 1, Math.ceil((1 + confidence) / 2 * iterations) - 1);
  return {
    lower: means[lowerIndex] ?? means[0] ?? 0,
    upper: means[upperIndex] ?? means[iterations - 1] ?? 0,
    confidence,
    iterations,
    seed
  };
}

function summaryOf(runs: PairedRun[], variantId: string): VariantExperimentSummary {
  const total = runs.length;
  const passed = runs.filter((run) => run.passed).length;
  const scores = runs.flatMap((run) => run.score === null ? [] : [run.score]);
  const durations = runs.flatMap((run) => run.durationMs === null ? [] : [run.durationMs]);
  const priced = runs.filter((run) => run.costUsd !== null);
  return {
    harnessVariantId: variantId,
    totalRuns: total,
    passed,
    passRate: total === 0 ? null : passed / total * 100,
    avgScore: scores.length === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / scores.length,
    totalUsd: priced.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    avgDurationMs: durations.length === 0 ? null : durations.reduce((sum, value) => sum + value, 0) / durations.length,
    wilson95: wilsonInterval(passed, total)
  };
}

function pairKey(run: PairedRun): string {
  return `${run.caseKey}\u0000${run.repetition}`;
}

export function compareVariants(input: {
  leftVariantId: string;
  rightVariantId: string;
  leftRuns: PairedRun[];
  rightRuns: PairedRun[];
  seed?: number | undefined;
}): PairedComparison {
  const left = summaryOf(input.leftRuns, input.leftVariantId);
  const right = summaryOf(input.rightRuns, input.rightVariantId);
  const leftMap = new Map(input.leftRuns.map((run) => [pairKey(run), run]));
  const rightMap = new Map(input.rightRuns.map((run) => [pairKey(run), run]));
  const pairs: Array<{ left: PairedRun; right: PairedRun }> = [];
  for (const [key, leftRun] of leftMap) {
    const rightRun = rightMap.get(key);
    if (rightRun) pairs.push({ left: leftRun, right: rightRun });
  }
  const warnings: string[] = [];
  if (pairs.length === 0) warnings.push("没有可对齐的成对运行，结论只能是描述性的");
  if (pairs.length < 10) warnings.push(`成对样本只有 ${pairs.length} 个，置信区间会很宽`);
  if (input.leftRuns.length !== input.rightRuns.length) warnings.push("两组运行数量不同，已按 case+repetition 对齐");

  const passDeltas = pairs.map((pair) => (pair.right.passed ? 1 : 0) - (pair.left.passed ? 1 : 0));
  const seed = input.seed ?? 20261127;
  const costValues = pairs.flatMap((pair) => pair.right.costUsd === null || pair.left.costUsd === null ? [] : [pair.right.costUsd - pair.left.costUsd]);
  const latencyValues = pairs.flatMap((pair) => pair.right.durationMs === null || pair.left.durationMs === null ? [] : [pair.right.durationMs - pair.left.durationMs]);
  const scoreValues = pairs.flatMap((pair) => pair.right.score === null || pair.left.score === null ? [] : [pair.right.score - pair.left.score]);

  const passRateDelta = passDeltas.length === 0 ? null : bootstrapMean(passDeltas, { seed });
  const costDeltaUsd = costValues.length === 0 ? null : bootstrapMean(costValues, { seed });
  const latencyDeltaMs = latencyValues.length === 0 ? null : bootstrapMean(latencyValues, { seed });
  const scoreDelta = scoreValues.length === 0 ? null : bootstrapMean(scoreValues, { seed });

  let direction: PairedComparison["direction"] = "inconclusive";
  if (passRateDelta) {
    if (passRateDelta.lower > 0) direction = "better";
    else if (passRateDelta.upper < 0) direction = "worse";
    else if (passRateDelta.lower === 0 && passRateDelta.upper === 0) direction = "same";
  } else if (left.passRate !== null && right.passRate !== null) {
    direction = right.passRate === left.passRate ? "same" : "inconclusive";
  }

  return {
    alignedPairs: pairs.length,
    left,
    right,
    passRateDelta,
    costDeltaUsd,
    latencyDeltaMs,
    scoreDelta,
    direction,
    warnings
  };
}
