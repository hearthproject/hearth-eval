import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type {
  BenchmarkDataset,
  BenchmarkImportInput,
  BenchmarkImportResult,
  BenchmarkJobCandidate,
  BenchmarkRun,
  BenchmarkRunStatus,
  BenchmarkTrial
} from "@hearth/eval-core";
import {
  computeTrialCost,
  normalizeTrialStatus,
  summarizeBenchmarkTrials
} from "@hearth/eval-core";
import type { BenchmarkTaskInput } from "./benchmark-store.ts";
import type { EvalStore } from "./store.ts";

const DEFAULT_DATASET = "terminal-bench/terminal-bench-2-1";
const DEFAULT_VERSION = "2.1";
const MAX_VERIFIER_OUTPUT = 32_000;
const HASH_LENGTH = 20;

type JsonRecord = Record<string, unknown>;

export type BenchmarkImportErrorCode =
  | "JOB_NOT_FOUND"
  | "JOB_OUTSIDE_ROOT"
  | "INVALID_JOB_JSON"
  | "NO_TRIALS"
  | "JOB_MISMATCH"
  | "REWARD_MISSING";

export class BenchmarkImportError extends Error {
  readonly code: BenchmarkImportErrorCode;
  readonly statusCode: number;

  constructor(code: BenchmarkImportErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = "BenchmarkImportError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ImportHarborJobOptions {
  store: EvalStore;
  jobsRoot: string;
  input: BenchmarkImportInput;
  now?: () => Date;
}

interface ParsedTrial {
  trialKey: string;
  taskKey: string;
  taskId: string;
  attemptHint: number | null;
  reward: number | null;
  status: BenchmarkTrial["status"];
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
  startedAt: string | null;
  completedAt: string | null;
  instructionPath: string | null;
  imageRef: string | null;
  timeoutSec: number | null;
  hasTokenUsage: boolean;
  hasReward: boolean;
  hasResult: boolean;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringOrNull(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function numberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function integerOrNull(...values: unknown[]): number | null {
  const value = numberOrNull(...values);
  return value === null ? null : Math.trunc(value);
}

function isoOrNull(...values: unknown[]): string | null {
  const value = stringOrNull(...values);
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function readJsonFile(path: string, required: boolean): JsonRecord | null {
  if (!existsSync(path)) {
    if (required) throw new BenchmarkImportError("INVALID_JOB_JSON", `Required JSON file is missing: ${path}`, 400);
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = asRecord(parsed);
    if (!record) throw new BenchmarkImportError("INVALID_JOB_JSON", `JSON file must contain an object: ${path}`, 400);
    return record;
  } catch (error) {
    if (error instanceof BenchmarkImportError) throw error;
    throw new BenchmarkImportError("INVALID_JOB_JSON", `Cannot parse JSON file: ${path}`, 400);
  }
}

function readTextFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function truncateOutput(value: string | null): string | null {
  if (value === null) return null;
  return value.length <= MAX_VERIFIER_OUTPUT
    ? value
    : `${value.slice(0, MAX_VERIFIER_OUTPUT)}\n...[truncated ${value.length - MAX_VERIFIER_OUTPUT} chars]`;
}

function hashId(value: string, prefix: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH)}`;
}

function normalizeRelativePath(value: string): string {
  return value.split("\\").join("/");
}

function parseRewardText(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function deriveTaskKey(trialKey: string): string {
  return trialKey.replace(/__[A-Za-z0-9]{4,16}$/, "");
}

function trialHasData(directory: string): boolean {
  return existsSync(join(directory, "config.json"))
    || existsSync(join(directory, "result.json"))
    || existsSync(join(directory, "verifier"));
}

function trialDirectories(jobDir: string): string[] {
  return readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => trialHasData(join(jobDir, name)))
    .sort((a, b) => a.localeCompare(b));
}

function readReward(trialDir: string, result: JsonRecord | null): {
  reward: number | null;
  rewardPath: string | null;
} {
  const rewards = asRecord(asRecord(result?.verifier_result)?.rewards);
  const direct = numberOrNull(rewards?.reward, result?.reward);
  if (direct !== null) return { reward: direct, rewardPath: "result.json" };

  const rewardTextPath = join(trialDir, "verifier", "reward.txt");
  const textReward = parseRewardText(readTextFile(rewardTextPath));
  if (textReward !== null) return { reward: textReward, rewardPath: "verifier/reward.txt" };

  const rewardJsonPath = join(trialDir, "verifier", "reward.json");
  const rewardJson = readJsonFile(rewardJsonPath, false);
  const jsonReward = numberOrNull(rewardJson?.reward);
  if (jsonReward !== null) return { reward: jsonReward, rewardPath: "verifier/reward.json" };

  return { reward: null, rewardPath: null };
}

function readTokens(result: JsonRecord | null, hearth: JsonRecord | null): {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
} {
  const agentResult = asRecord(result?.agent_result);
  const usage = asRecord(hearth?.usage);
  return {
    inputTokens: numberOrNull(agentResult?.n_input_tokens, agentResult?.input_tokens, usage?.inputTokens, usage?.input_tokens),
    outputTokens: numberOrNull(agentResult?.n_output_tokens, agentResult?.output_tokens, usage?.outputTokens, usage?.output_tokens),
    cachedTokens: numberOrNull(agentResult?.n_cached_tokens, agentResult?.cached_tokens, usage?.cachedTokens, usage?.cached_tokens)
  };
}

function readDuration(result: JsonRecord | null, config: JsonRecord): number | null {
  const agentResult = asRecord(result?.agent_result);
  const timing = asRecord(result?.timing);
  const explicit = numberOrNull(
    result?.duration_ms,
    result?.durationMs,
    agentResult?.duration_ms,
    agentResult?.durationMs,
    timing?.total_ms,
    timing?.duration_ms
  );
  if (explicit !== null) return Math.max(0, Math.trunc(explicit));

  const started = isoOrNull(config.started_at, result?.started_at);
  const completed = isoOrNull(result?.completed_at, result?.ended_at);
  if (started && completed) {
    const delta = Date.parse(completed) - Date.parse(started);
    return Number.isFinite(delta) ? Math.max(0, delta) : null;
  }
  return null;
}

function readTaskMetadata(config: JsonRecord): {
  instructionPath: string | null;
  imageRef: string | null;
  timeoutSec: number | null;
} {
  const task = asRecord(config.task);
  const environment = asRecord(task?.environment);
  return {
    instructionPath: stringOrNull(task?.instruction_path, task?.instructionPath),
    imageRef: stringOrNull(environment?.image, config.image),
    timeoutSec: numberOrNull(task?.timeout_sec, task?.timeoutSec, config.timeout_sec)
  };
}

export function resolveHarborJobDir(jobsRoot: string, requested: string): { absolute: string; relativePath: string } {
  const root = resolve(jobsRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new BenchmarkImportError("JOB_NOT_FOUND", `Harbor jobs root does not exist: ${root}`, 404);
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new BenchmarkImportError("JOB_NOT_FOUND", `Harbor job directory does not exist: ${requested}`, 404);
  }
  const realRoot = realpathSync(root);
  const realJob = realpathSync(candidate);
  const relativePath = normalizeRelativePath(relative(realRoot, realJob));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new BenchmarkImportError("JOB_OUTSIDE_ROOT", `Harbor job must be inside the configured jobs root: ${requested}`, 403);
  }
  return { absolute: realJob, relativePath };
}

function parseTrial(
  jobDir: string,
  trialKey: string,
  pricing: BenchmarkImportInput["pricing"],
  nowIso: string
): ParsedTrial {
  const trialDir = join(jobDir, trialKey);
  const config = readJsonFile(join(trialDir, "config.json"), false) ?? {};
  const result = readJsonFile(join(trialDir, "result.json"), false);
  const hearth = readJsonFile(join(trialDir, "agent", "hearth-result.json"), false);
  const taskConfig = asRecord(config.task);
  const taskKey = stringOrNull(config.task_name, taskConfig?.name, taskConfig?.id, result?.task_name) ?? deriveTaskKey(trialKey);
  const taskMetadata = readTaskMetadata(config);
  const { reward, rewardPath } = readReward(trialDir, result);
  const tokens = readTokens(result, hearth);
  const exception = asRecord(result?.exception_info) ?? asRecord(result?.exception);
  const exceptionType = stringOrNull(exception?.type, exception?.exception_type, exception?.name);
  const exceptionMessage = stringOrNull(exception?.message, exception?.exception_message);
  const hearthStatus = stringOrNull(hearth?.status);

  const harborCost = numberOrNull(
    asRecord(result?.agent_result)?.cost_usd,
    asRecord(result?.agent_result)?.cost,
    result?.cost_usd
  );
  const computedCost = pricing && (tokens.inputTokens !== null || tokens.outputTokens !== null || tokens.cachedTokens !== null)
    ? computeTrialCost(tokens, pricing)
    : null;

  return {
    trialKey,
    taskKey,
    taskId: "",
    attemptHint: integerOrNull(config.attempt, result?.attempt),
    reward,
    status: normalizeTrialStatus({
      reward,
      exceptionType,
      exceptionMessage,
      hearthStatus
    }),
    durationMs: readDuration(result, config),
    ...tokens,
    costUsd: computedCost ?? harborCost,
    rewardPath,
    resultPath: result ? "result.json" : null,
    errorCode: reward === null && exception === null ? "REWARD_MISSING" : exception ? "TRIAL_EXCEPTION" : null,
    errorMessage: reward === null && exception === null
      ? "Verifier did not produce a reward"
      : exceptionMessage ?? exceptionType,
    verifierStdout: truncateOutput(readTextFile(join(trialDir, "verifier", "test-stdout.txt"))),
    verifierStderr: truncateOutput(readTextFile(join(trialDir, "verifier", "test-stderr.txt"))),
    raw: { config, result, hearth },
    createdAt: nowIso,
    startedAt: isoOrNull(config.started_at, result?.started_at),
    completedAt: isoOrNull(result?.completed_at, result?.ended_at),
    ...taskMetadata,
    hasTokenUsage: tokens.inputTokens !== null || tokens.outputTokens !== null || tokens.cachedTokens !== null,
    hasReward: reward !== null,
    hasResult: result !== null
  };
}

function assignAttempts(trials: ParsedTrial[]): void {
  const byTask = new Map<string, ParsedTrial[]>();
  for (const trial of trials) {
    const group = byTask.get(trial.taskKey) ?? [];
    group.push(trial);
    byTask.set(trial.taskKey, group);
  }
  for (const group of byTask.values()) {
    group.sort((a, b) => {
      const aTime = a.startedAt ? Date.parse(a.startedAt) : 0;
      const bTime = b.startedAt ? Date.parse(b.startedAt) : 0;
      return aTime - bTime || a.trialKey.localeCompare(b.trialKey);
    });
    let ordinal = 0;
    for (const trial of group) {
      ordinal += 1;
      trial.attemptHint = trial.attemptHint ?? ordinal;
    }
  }
}

export function buildBenchmarkRunId(input: {
  datasetId: string;
  jobId: string;
  harnessName: string;
  harnessVersion: string;
  model: string;
}): string {
  return hashId(
    [input.datasetId, input.jobId, input.harnessName, input.harnessVersion, input.model].join("\u0000"),
    "br"
  );
}

export function listHarborJobCandidates(jobsRoot: string): { root: string; jobs: BenchmarkJobCandidate[] } {
  const root = resolve(jobsRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) return { root, jobs: [] };
  const jobs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const directory = join(root, entry.name);
      const stat = statSync(directory);
      return {
        name: entry.name,
        path: entry.name,
        modifiedAt: stat.mtime.toISOString(),
        hasConfig: existsSync(join(directory, "config.json")),
        hasResult: existsSync(join(directory, "result.json")),
        trialCount: trialDirectories(directory).length
      };
    })
    .filter((job) => job.hasConfig || job.hasResult || job.trialCount > 0)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { root, jobs };
}

export function importHarborJob(options: ImportHarborJobOptions): BenchmarkImportResult {
  const now = options.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const input = options.input;
  const resolved = resolveHarborJobDir(options.jobsRoot, input.jobDir);
  const jobDir = resolved.absolute;
  const jobConfig = readJsonFile(join(jobDir, "config.json"), false) ?? {};
  const jobResult = readJsonFile(join(jobDir, "result.json"), false);
  const datasetConfig = asRecord(jobConfig.dataset);
  const agentConfig = asRecord(jobConfig.agent);
  const jobId = stringOrNull(jobConfig.job_name, jobConfig.name, jobResult?.job_name) ?? basename(jobDir);
  const datasetName = input.datasetName
    ?? stringOrNull(datasetConfig?.name, typeof jobConfig.dataset === "string" ? jobConfig.dataset : null)
    ?? DEFAULT_DATASET;
  const datasetVersion = input.datasetVersion
    ?? stringOrNull(datasetConfig?.version, datasetConfig?.tag)
    ?? DEFAULT_VERSION;
  const datasetId = `${datasetName}@${datasetVersion}`;
  const harnessName = input.harnessName
    ?? stringOrNull(agentConfig?.name, typeof jobConfig.agent === "string" ? jobConfig.agent : null)
    ?? "hearth-native";
  const harnessVersion = input.harnessVersion
    ?? stringOrNull(agentConfig?.version)
    ?? "unknown";
  const model = input.model
    ?? stringOrNull(jobConfig.model, jobConfig.model_name)
    ?? "unknown";
  const runId = buildBenchmarkRunId({ datasetId, jobId, harnessName, harnessVersion, model });

  const trialKeys = trialDirectories(jobDir);
  if (trialKeys.length === 0) {
    throw new BenchmarkImportError("NO_TRIALS", `Harbor job has no trial directories: ${resolved.relativePath}`, 400);
  }

  const parsed = trialKeys.map((trialKey) => parseTrial(jobDir, trialKey, input.pricing, nowIso));
  assignAttempts(parsed);

  const taskKeys = [...new Set(parsed.map((trial) => trial.taskKey))];
  const taskIds = new Map(taskKeys.map((taskKey) => [
    taskKey,
    hashId(`${datasetId}:${taskKey}`, "btask")
  ]));
  const trials: BenchmarkTrial[] = parsed.map((trial) => ({
    id: hashId(`${runId}:${trial.trialKey}`, "bt"),
    runId,
    taskId: taskIds.get(trial.taskKey) as string,
    taskKey: trial.taskKey,
    trialKey: trial.trialKey,
    attempt: trial.attemptHint ?? 1,
    reward: trial.reward,
    status: trial.status,
    durationMs: trial.durationMs,
    inputTokens: trial.inputTokens,
    outputTokens: trial.outputTokens,
    cachedTokens: trial.cachedTokens,
    costUsd: trial.costUsd,
    rewardPath: trial.rewardPath,
    resultPath: trial.resultPath,
    errorCode: trial.errorCode,
    errorMessage: trial.errorMessage,
    verifierStdout: trial.verifierStdout,
    verifierStderr: trial.verifierStderr,
    raw: trial.raw,
    createdAt: trial.createdAt
  }));

  const summary = summarizeBenchmarkTrials(trials, input.pricing);
  const endedAt = isoOrNull(jobResult?.completed_at, jobResult?.ended_at)
    ?? parsed.map((trial) => trial.completedAt).filter((value): value is string => value !== null).sort().at(-1)
    ?? null;
  const startedAt = isoOrNull(jobConfig.started_at, jobConfig.created_at, jobResult?.started_at)
    ?? parsed.map((trial) => trial.startedAt).filter((value): value is string => value !== null).sort()[0]
    ?? null;
  const runStatus: BenchmarkRunStatus = summary.infraErrorRate > 0 ? "partial" : "imported";
  const declaredTaskCount = input.datasetTaskCount
    ?? numberOrNull(datasetConfig?.task_count)
    ?? taskKeys.length;

  const warnings: string[] = [];
  if (!jobResult) warnings.push("Job result.json is missing; job metadata falls back to config.json.");
  const missingTokens = parsed.filter((trial) => !trial.hasTokenUsage).length;
  if (missingTokens > 0) warnings.push(`${missingTokens} trial(s) do not report token usage.`);
  const missingRewards = parsed.filter((trial) => !trial.hasReward).length;
  if (missingRewards > 0) warnings.push(`${missingRewards} trial(s) do not have a verifier reward and were stored as errors.`);

  if (!input.dryRun) {
    const dataset: BenchmarkDataset = {
      id: datasetId,
      name: datasetName,
      version: datasetVersion,
      source: "harbor",
      commitSha: input.datasetCommitSha ?? stringOrNull(datasetConfig?.commit_sha),
      digest: input.datasetDigest ?? stringOrNull(datasetConfig?.digest),
      taskCount: declaredTaskCount,
      createdAt: nowIso
    };
    const run: BenchmarkRun = {
      id: runId,
      datasetId,
      jobId,
      harnessName,
      harnessVersion,
      model,
      status: runStatus,
      startedAt,
      endedAt,
      config: jobConfig,
      rawDir: jobDir,
      summary: null,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    options.store.benchmarks.transaction(() => {
      options.store.benchmarks.saveDataset(dataset);
      for (const taskKey of taskKeys) {
        const first = parsed.find((trial) => trial.taskKey === taskKey) as ParsedTrial;
        const task: BenchmarkTaskInput = {
          id: taskIds.get(taskKey) as string,
          datasetId,
          taskKey,
          instructionPath: first.instructionPath,
          imageRef: first.imageRef,
          timeoutSec: first.timeoutSec,
          metadata: { firstTrialKey: first.trialKey }
        };
        options.store.benchmarks.upsertTask(task);
      }
      options.store.benchmarks.saveRun({
        id: run.id,
        datasetId: run.datasetId,
        jobId: run.jobId,
        harnessName: run.harnessName,
        harnessVersion: run.harnessVersion,
        model: run.model,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        config: run.config,
        rawDir: run.rawDir,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      });
      options.store.benchmarks.replaceTrials(runId, trials);
      options.store.benchmarks.updateRunSummary(runId, runStatus, summary, endedAt);
    });
  }

  return {
    runId,
    jobId,
    datasetId,
    dryRun: input.dryRun === true,
    trialCount: trials.length,
    taskCount: taskKeys.length,
    summary,
    warnings
  };
}
