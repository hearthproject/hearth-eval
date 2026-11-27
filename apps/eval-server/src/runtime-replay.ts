// Eval-side runtime replay orchestration.
//
// A replay is always executed by the OS ReplayService over the recorded cassette;
// Eval never runs its own model/tool loop for a replay. This module only selects
// the cassette, forwards an optional one-shot counterfactual override, and maps
// the returned divergence into the evaluation vocabulary.
import type { DivergenceReport, FirstDivergenceClass, RuntimeExchange, RuntimeManifest } from "@hearth/eval-core";
import { classifyDivergence } from "@hearth/eval-core";
import type { EvidenceClient } from "./evidence-client.ts";

export interface ReplaySummary {
  runId: string;
  cassetteId: string;
  report: DivergenceReport;
  divergenceClass: FirstDivergenceClass;
  strict: boolean;
  providerCalls: number;
  toolExecutions: number;
  simulatedReceipts: number;
  reproductionCommand: string;
}

export interface ReplayOptions {
  cassetteId?: string | null;
  mode?: "strict_replay" | "live_on_divergence";
  replacement?: {
    exchangeId: string;
    output: unknown;
  } | null;
  timeoutMs?: number;
}

export function cassetteIdForRun(runId: string): string {
  return runId.startsWith("cassette:") ? runId : `cassette:${runId}`;
}

export async function replayRun(client: EvidenceClient, runId: string, options: ReplayOptions = {}): Promise<ReplaySummary> {
  const cassetteId = options.cassetteId ?? cassetteIdForRun(runId);
  const mode = options.mode ?? "strict_replay";
  const response = await client.replay({
    cassetteId,
    mode,
    ...(options.replacement ? { replacement: options.replacement as unknown as Record<string, unknown> } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
  });
  const report = response.report;
  if (mode === "strict_replay" && (report.providerCalls > 0 || report.toolExecutions > 0)) {
    throw new Error(`strict replay 发生了真实调用：providerCalls=${report.providerCalls}, toolExecutions=${report.toolExecutions}`);
  }
  return {
    runId,
    cassetteId,
    report,
    divergenceClass: classifyDivergence(report),
    strict: mode === "strict_replay",
    providerCalls: report.providerCalls,
    toolExecutions: report.toolExecutions,
    simulatedReceipts: report.simulatedReceipts,
    reproductionCommand: report.reproductionCommand
  };}

export interface ForkReplaySummary {
  parentRunId: string;
  forkRunId: string;
  checkpointSeq: number;
  report: DivergenceReport;
  divergenceClass: FirstDivergenceClass;
  status: string;
}

export async function forkAtCheckpoint(client: EvidenceClient, input: {
  runId: string;
  checkpointSeq?: number;
  replacement?: { exchangeId: string; output: unknown } | null;
  label?: string;
  timeoutMs?: number;
}): Promise<ForkReplaySummary> {
  const response = await client.fork({
    runId: input.runId,
    ...(input.checkpointSeq !== undefined ? { checkpointSeq: input.checkpointSeq } : {}),
    ...(input.replacement ? { replacement: input.replacement as unknown as Record<string, unknown> } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {})
  });
  return {
    parentRunId: response.report.parentRunId ?? input.runId,
    forkRunId: response.forkRunId ?? response.run.id,
    checkpointSeq: response.report.checkpointSeq ?? input.checkpointSeq ?? 0,
    report: response.report,
    divergenceClass: classifyDivergence(response.report),
    status: response.run.status
  };
}

export interface RunEvidenceBundle {
  runId: string;
  manifest: RuntimeManifest;
  exchanges: RuntimeExchange[];
  cost: Record<string, unknown> | null;
}

/** Fetch the evidence needed for a report in one place, without touching the DB. */
export async function loadRunEvidence(client: EvidenceClient, runId: string, taskId?: string | null): Promise<RunEvidenceBundle> {
  const [manifest, exchanges, cost] = await Promise.all([
    client.manifest(runId),
    client.exchanges(runId).catch(() => ({ exchanges: [] as RuntimeExchange[] })),
    taskId ? client.cost(taskId).catch(() => null) : Promise.resolve(null)
  ]);
  return {
    runId,
    manifest,
    exchanges: exchanges.exchanges ?? [],
    cost: cost ? { entries: cost.entries, statuses: cost.statuses } : null
  };
}

/** Summarize which evidence is missing from a run, for report honesty. */
export function evidenceGaps(bundle: RunEvidenceBundle): string[] {
  const gaps: string[] = [];
  if (bundle.manifest.completeness.status !== "complete") {
    gaps.push(...bundle.manifest.completeness.missing.map((field) => `manifest.${field}`));
  }
  if (bundle.exchanges.length === 0) gaps.push("cassette.exchanges");
  const kinds = new Set(bundle.exchanges.map((exchange) => exchange.kind));
  for (const required of ["model.request", "model.response", "tool.call", "tool.result"] as const) {
    if (!kinds.has(required)) gaps.push(`cassette.${required}`);
  }
  return gaps;
}
