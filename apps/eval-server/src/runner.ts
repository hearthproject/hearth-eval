import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  ArtifactMap,
  CaseManifest,
  CreateExperimentRequest,
  EvalInput,
  ExperimentEnvironment,
  ExperimentRecord,
  ExperimentRunRecord,
  ExperimentRunStatus,
  ExperimentSummary,
  ExperimentCostSummary,
  VariantExperimentSummary,
  GraderResultRecord,
  HumanReviewRecord,
  JudgeCriterionResult
} from "@hearth/eval-core";
import {
  EVAL_FAMILIES,
  attributePrimaryCause,
  buildEvalTrace,
  emptyFamilySummaries,
  familySummary,
  observeTrace,
  runGrader,
  runTraceGrader,
  runVerificationSpec,
  scoreRun,
  type GraderOutcome,
  type GateOutcomeInput,
  type GateLayer,
  type JudgeOutcome,
  type EvalTrace,
  type TraceObservation,
  type RawTraceEvent,
  type MetricSummary,
  type JudgeCalibrationSummary,
  type RegressionReport,
  type ReplayCaseResult,
  aggregateMetrics,
  emptyMetrics,
  metricSummaries,
  wilsonInterval,
  buildExperimentManifest
} from "@hearth/eval-core";
import { resolveCaseInput, type LoadedCase } from "@hearth/eval-core/node";
import { isTerminalTaskStatus, type AgentAdapter, type AgentTaskView } from "./agent-adapter.ts";
import type { EvalStore, RecoverySummary, RunMetrics } from "./store.ts";
import type { JudgeAdapter } from "./judge-adapter.ts";
import { resolveRunOutputDir } from "./artifact-path.ts";
import { compileCaseVerification } from "./verification-adapter.ts";

export class EvalRunnerError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "EvalRunnerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface RunnerOptions {
  store: EvalStore;
  client: AgentAdapter;
  judge?: JudgeAdapter;
  repoRoot: string;
  catalog: Map<string, LoadedCase>;
  evalVersion: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  pollIntervalMs?: number;
  recoveryStaleMs?: number;
  artifactRoot?: string;
}

interface TaskWaitResult {
  status: string;
  task: AgentTaskView["task"];
  view: AgentTaskView | null;
  timedOut: boolean;
}

interface GradeResult {
  graderRecords: GraderResultRecord[];
  deterministic: Record<string, GraderOutcome>;
  judge: JudgeOutcome | null;
  judgeExpected: boolean;
  outcome: ReturnType<typeof scoreRun>;
}

export class EvalRunner {
  private readonly store: EvalStore;
  private readonly client: AgentAdapter;
  private readonly judge: JudgeAdapter | null;
  private readonly repoRoot: string;
  private readonly catalog: Map<string, LoadedCase>;
  private readonly evalVersion: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly recoveryStaleMs: number;
  private readonly artifactRoot: string;
  private readonly active = new Set<string>();

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.client = options.client;
    this.judge = options.judge ?? null;
    this.repoRoot = options.repoRoot;
    this.catalog = options.catalog;
    this.evalVersion = options.evalVersion;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.recoveryStaleMs = options.recoveryStaleMs ?? 30 * 60_000;
    this.artifactRoot = options.artifactRoot ?? resolve(options.repoRoot, ".hearth", "eval-artifacts");
  }

  async collectEnvironment(judgeModel: string | null): Promise<ExperimentEnvironment> {
    let health: Record<string, unknown> = {};
    try {
      health = await this.client.health();
    } catch {
      health = {};
    }
    return {
      hearthUrl: this.client.baseUrl,
      hearthNow: typeof health.now === "string" ? health.now : null,
      schemaVersion: typeof health.schemaVersion === "number" ? health.schemaVersion : null,
      instanceId: typeof health.instanceId === "string" ? health.instanceId : null,
      executorSettings: asRecord(health.executors) ?? {},
      judgeModel,
      evalVersion: this.evalVersion
    };
  }

  createExperiment(request: CreateExperimentRequest, environment: ExperimentEnvironment): ExperimentRecord {
    const caseIds = [...new Set(request.caseIds.map((id) => id.trim()).filter(Boolean))];
    if (caseIds.length === 0) throw new EvalRunnerError("NO_CASES", "至少选择一个 case", 400);
    if (caseIds.length > 200) throw new EvalRunnerError("TOO_MANY_CASES", "单次实验最多包含 200 个 case", 400);
    const executorIds = [...new Set(request.executorIds.map((id) => id.trim()).filter(Boolean))];
    if (executorIds.length === 0) throw new EvalRunnerError("NO_EXECUTORS", "至少选择一个执行器", 400);
    if (request.repetitions < 1 || request.repetitions > 5) throw new EvalRunnerError("INVALID_REPETITIONS", "重复次数必须在 1 到 5 之间", 400);
    if (request.maxConcurrency < 1 || request.maxConcurrency > 8) throw new EvalRunnerError("INVALID_CONCURRENCY", "并发数必须在 1 到 8 之间", 400);

    const unsupported: string[] = [];
    const selected: LoadedCase[] = [];
    for (const caseId of caseIds) {
      const loaded = this.catalog.get(caseId);
      if (!loaded) throw new EvalRunnerError("CASE_NOT_FOUND", `case 不存在：${caseId}`, 404);
      if (!supportsRunMode(loaded.manifest, request.runMode)) {
        unsupported.push(caseId);
        continue;
      }
      selected.push(loaded);
    }
    if (unsupported.length > 0) {
      throw new EvalRunnerError("CASE_MODE_UNSUPPORTED", `这些 case 不支持 ${request.runMode} 模式：${unsupported.join(", ")}`, 400);
    }

    const id = `EXP-${this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
    const createdAt = this.now().toISOString();
    const config = {
      name: request.name?.trim() || `评测 ${id.slice(-6)}`,
      caseIds,
      executorIds,
      repetitions: request.repetitions,
      runMode: request.runMode,
      autoJudge: request.autoJudge,
      autoRetry: request.autoRetry,
      maxConcurrency: request.maxConcurrency,
      baselineExperimentId: request.baselineExperimentId ?? null,
      ...(request.harnessVariantId ? { harnessVariantId: request.harnessVariantId } : {}),
      ...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {})
    };
    const experiment: ExperimentRecord = {
      id,
      name: config.name,
      status: "queued",
      config,
      environment,
      createdAt,
      startedAt: null,
      finishedAt: null,
      summary: null
    };
    const runs: ExperimentRunRecord[] = [];
    for (const loaded of selected) {
      for (const executorId of executorIds) {
        for (let repetition = 1; repetition <= request.repetitions; repetition += 1) {
          runs.push({
            id: randomUUID(),
            experimentId: id,
            caseKey: loaded.manifest.id,
            caseVersion: loaded.manifest.version,
            caseContentHash: loaded.contentHash,
            executorId,
            repetition,
            status: "queued",
            hearthTaskId: null,
            outputDir: `.hearth/eval-artifacts/${id}/${loaded.manifest.id}/${executorId}/r${repetition}`,
            externalRef: `eval:${id}:${loaded.manifest.id}:${executorId}:r${repetition}`,
            attempt: 1,
            startedAt: null,
            finishedAt: null,
            score: null,
            error: null,
            reviewReasons: [],
            createdAt,
            updatedAt: createdAt
          });
        }
      }
    }
    this.store.createExperiment(experiment);
    this.store.createRuns(runs);
    const manifest = buildExperimentManifest({
      experimentId: id,
      name: experiment.name,
      createdAt: experiment.createdAt,
      cases: selected.map((loaded) => loaded.manifest),
      environment,
      judge: environment.judgeModel ? { model: environment.judgeModel, promptHash: null, calibrationVersion: null } : null
    });
    this.store.saveExperimentManifest(id, manifest.compatibilityFingerprint, manifest as unknown as Record<string, unknown>);
    this.store.appendEvent("experiment.manifest", {
      experimentId: id,
      payload: { fingerprint: manifest.compatibilityFingerprint, completeness: manifest.completeness }
    });
    this.store.appendEvent("experiment.created", {
      experimentId: id,
      payload: { cases: selected.length, executors: executorIds.length, repetitions: request.repetitions, runs: runs.length }
    });
    return experiment;
  }

  start(experimentId: string): void {
    if (this.active.has(experimentId)) return;
    this.active.add(experimentId);
    void this.runExperiment(experimentId)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateExperiment(experimentId, { status: "failed", finishedAt: this.now().toISOString() });
        this.store.appendEvent("experiment.failed", { experimentId, payload: { error: message } });
      })
      .finally(() => this.active.delete(experimentId));
  }

  cancel(experimentId: string): ExperimentRecord {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new EvalRunnerError("EXPERIMENT_NOT_FOUND", "实验不存在", 404);
    if (["completed", "failed", "cancelled"].includes(experiment.status)) return experiment;
    const finishedAt = this.now().toISOString();
    for (const run of this.store.listRuns(experimentId)) {
      if (!["queued", "created", "running", "waiting", "grading"].includes(run.status)) continue;
      this.store.updateRun(run.id, { status: "cancelled", finishedAt, updatedAt: finishedAt });
      if (run.hearthTaskId) void this.client.cancelTask(run.hearthTaskId).catch(() => undefined);
    }
    this.store.updateExperiment(experimentId, { status: "cancelled", finishedAt });
    this.store.appendEvent("experiment.cancelled", { experimentId });
    return this.store.getExperiment(experimentId) ?? experiment;
  }

  summarize(experimentId: string): ExperimentSummary | null {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) return null;
    const runs = this.store.listRuns(experimentId);
    const rows = runs.map((run) => {
      const family = this.store.getCase(run.caseKey)?.summary.family ?? "cross-app";
      return {
        family,
        status: run.status,
        score: run.score,
        reviewPending: run.reviewReasons.length > 0 && !this.store.getHumanReview(run.id)
      };
    });
    const families = EVAL_FAMILIES.map((family) => familySummary(family, rows));
    const passed = runs.filter((run) => run.status === "passed").length;
    const failed = runs.filter((run) => run.status === "failed" || run.status === "error").length;
    const blocked = runs.filter((run) => run.status === "blocked").length;
    const needsReview = runs.filter((run) => run.reviewReasons.length > 0 && !this.store.getHumanReview(run.id)).length;
    const scores = runs.flatMap((run) => run.score === null ? [] : [run.score]);
    const durations = runs.flatMap((run) => run.startedAt && run.finishedAt
      ? [Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))]
      : []);
    const runMetrics = runs.map((run) => this.store.getRunMetrics(run.id));
    return {
      experimentId,
      totalRuns: runs.length,
      passed,
      failed,
      blocked,
      needsReview,
      passRate: runs.length === 0 ? null : round(passed / runs.length * 100),
      avgScore: scores.length === 0 ? null : round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      avgDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      inputTokens: runMetrics.reduce((sum, metric) => sum + (metric?.inputTokens ?? 0), 0),
      outputTokens: runMetrics.reduce((sum, metric) => sum + (metric?.outputTokens ?? 0), 0),
      retries: runMetrics.reduce((sum, metric) => sum + (metric?.retryCount ?? 0), 0),
      approvals: runMetrics.reduce((sum, metric) => sum + (metric?.approvalCount ?? 0), 0),
      families: families.length > 0 ? families : emptyFamilySummaries(),
      metrics: aggregateMetrics(runs.map((run) => {
        const loaded = this.catalog.get(run.caseKey);
        return loaded ? this.runMetricSummary(run, loaded) : emptyMetrics();
      })),
      judgeCalibration: this.judgeCalibration(runs),
      failureDiagnostics: diagnosticGroups(runs),
      generatedAt: this.now().toISOString(),
      cost: costSummaryFor(runs, runMetrics),
      variant: variantSummaryFor(experiment, runs, runMetrics)
    };
  }

  metricsForRun(runId: string): MetricSummary[] {
    const run = this.store.getRun(runId);
    const loaded = run ? this.catalog.get(run.caseKey) : undefined;
    return run && loaded ? this.runMetricSummary(run, loaded) : emptyMetrics();
  }

  private runMetricSummary(run: ExperimentRunRecord, loaded: LoadedCase): MetricSummary[] {
    const records = this.store.listGraderResults(run.id);
    const deterministic = deterministicFromRecords(records);
    const judge = judgeFromRecords(records);
    const review = this.store.getHumanReview(run.id);
    const trace = this.store.getTrace(run.id);
    const runMetrics = this.store.getRunMetrics(run.id);
    const durationMs = run.startedAt
      ? Math.max(0, Date.parse(run.finishedAt ?? this.now().toISOString()) - Date.parse(run.startedAt))
      : null;
    const tokens = runMetrics ? runMetrics.inputTokens + runMetrics.outputTokens : null;
    const observation: TraceObservation | null = trace || durationMs !== null || tokens !== null
      ? {
        steps: trace?.steps ?? 0,
        toolCalls: trace?.toolCalls ?? 0,
        approvals: trace?.approvals ?? 0,
        effects: trace?.effects ?? 0,
        errors: trace?.errors.length ?? 0,
        durationMs,
        tokens
      }
      : null;
    return metricSummaries({
      manifest: loaded.manifest,
      verdict: run.status === "passed" ? "passed" : run.status === "failed" || run.status === "error" ? "failed" : "needs_review",
      deterministic,
      judge,
      humanDecision: review?.decision ?? null,
      gates: gateOutcomes(loaded.manifest, deterministic, judge),
      observation,
      timeoutMs: loaded.manifest.timeoutMs
    });
  }

  private judgeCalibration(runs: ExperimentRunRecord[]): JudgeCalibrationSummary {
    let expectedRuns = 0;
    let judgedRuns = 0;
    let reviewedRuns = 0;
    let agreed = 0;
    let falsePass = 0;
    let falseFail = 0;
    let lowConfidenceRuns = 0;
    for (const run of runs) {
      const loaded = this.catalog.get(run.caseKey);
      const experiment = this.store.getExperiment(run.experimentId);
      const judgeCriteria = loaded?.manifest.criteria.filter((criterion) => criterion.source === "judge") ?? [];
      const judgeRecords = this.store.listGraderResults(run.id).filter((result) => result.source === "judge");
      if (experiment?.config.autoJudge && judgeCriteria.length > 0) expectedRuns += 1;
      if (judgeRecords.length > 0) judgedRuns += 1;
      if (judgeRecords.some((result) => result.confidence !== null && result.confidence < 0.7)) lowConfidenceRuns += 1;
      const review = this.store.getHumanReview(run.id);
      if (!review || review.decision === "unknown" || judgeRecords.length === 0) continue;
      reviewedRuns += 1;
      const judgePassed = judgeRecords.every((result) => result.passed);
      const humanPassed = review.decision === "pass";
      if (judgePassed === humanPassed) agreed += 1;
      else if (judgePassed) falsePass += 1;
      else falseFail += 1;
    }
    return {
      expectedRuns,
      judgedRuns,
      coverage: expectedRuns === 0 ? null : round(judgedRuns / expectedRuns * 100),
      reviewedRuns,
      agreement: reviewedRuns === 0 ? null : round(agreed / reviewedRuns * 100),
      falsePass,
      falseFail,
      lowConfidenceRuns,
      lowConfidenceRate: judgedRuns === 0 ? null : round(lowConfidenceRuns / judgedRuns * 100)
    };
  }

  regressionReport(experimentId: string, baselineExperimentId: string): RegressionReport {
    const experiment = this.store.getExperiment(experimentId);
    const baseline = this.store.getExperiment(baselineExperimentId);
    if (!experiment) throw new EvalRunnerError("EXPERIMENT_NOT_FOUND", "实验不存在", 404);
    if (!baseline) throw new EvalRunnerError("BASELINE_NOT_FOUND", "基线实验不存在", 404);
    const baselineByKey = new Map(this.store.listRuns(baseline.id).map((run) => [runKey(run), run]));
    const cases: ReplayCaseResult[] = [];
    let replayable = 0;
    let skipped = 0;
    let regressions = 0;
    let fixes = 0;
    let missingEvidence = 0;
    let blockingMissingEvidence = 0;
    const reasons: string[] = [];
    for (const run of this.store.listRuns(experiment.id)) {
      const baselineRun = baselineByKey.get(runKey(run)) ?? null;
      const loaded = this.catalog.get(run.caseKey);
      const baseResult: ReplayCaseResult = {
        runId: run.id,
        caseKey: run.caseKey,
        executorId: run.executorId,
        repetition: run.repetition,
        baselineRunId: baselineRun?.id ?? null,
        baselineStatus: baselineRun?.status ?? null,
        baselineScore: baselineRun?.score ?? null,
        verdict: null,
        score: null,
        delta: null,
        deterministicChanged: false,
        changedCriteria: [],
        regression: false,
        reason: null
      };
      if (!loaded || !baselineRun) {
        skipped += 1;
        cases.push({ ...baseResult, reason: loaded ? "基线中没有对齐的 case" : "catalog 中缺少 case" });
        continue;
      }
      const replay = this.replayRun(run, loaded);
      if (!replay) {
        skipped += 1;
        missingEvidence += 1;
        if (baselineRun.status === "passed") {
          blockingMissingEvidence += 1;
          reasons.push(`${run.caseKey} 缺少固定证据，无法证明基线通过仍然成立`);
        }
        cases.push({ ...baseResult, reason: "缺少可回放证据（产物、trace 或 Judge 结果）" });
        continue;
      }
      replayable += 1;
      const score = replay.outcome.score;
      const delta = score !== null && baselineRun.score !== null ? round(score - baselineRun.score) : null;
      const decided = ["passed", "failed"].includes(baselineRun.status);
      const regressed = decided && (
        (baselineRun.status === "passed" && replay.outcome.verdict !== "passed")
        || (delta !== null && delta <= -5)
      );
      const fixed = decided && baselineRun.status !== "passed" && replay.outcome.verdict === "passed";
      if (regressed) {
        regressions += 1;
        reasons.push(`${run.caseKey} 回归：${baselineRun.status} → ${replay.outcome.verdict}（${delta === null ? "分数不可比" : `${delta > 0 ? "+" : ""}${delta}`}）`);
      }
      if (fixed) fixes += 1;
      cases.push({
        ...baseResult,
        verdict: replay.outcome.verdict,
        score,
        delta,
        deterministicChanged: replay.deterministicChanged,
        changedCriteria: replay.changedCriteria,
        regression: regressed,
        reason: decided ? null : "基线尚未形成可比较结论"
      });
    }
    cases.sort((left, right) => left.caseKey.localeCompare(right.caseKey) || left.executorId.localeCompare(right.executorId) || left.repetition - right.repetition);
    return {
      experimentId,
      baselineExperimentId,
      replayable,
      skipped,
      regressions,
      fixes,
      missingEvidence,
      blockingMissingEvidence,
      regressionBlocked: regressions > 0 || blockingMissingEvidence > 0,
      reasons,
      cases,
      generatedAt: this.now().toISOString()
    };
  }

  private replayRun(
    run: ExperimentRunRecord,
    loaded: LoadedCase
  ): { outcome: ReturnType<typeof scoreRun>; deterministicChanged: boolean; changedCriteria: string[] } | null {
    const manifest = loaded.manifest;
    const records = this.store.listGraderResults(run.id);
    if (records.length === 0) return null;
    const stored = deterministicFromRecords(records);
    const artifacts = this.readArtifacts(run.outputDir);
    if (Object.keys(artifacts).length === 0 && manifest.expectedOutputs.length > 0) return null;
    const trace = this.store.getTrace(run.id);
    const traceCriteria = manifest.criteria.filter((criterion) => {
      const grader = manifest.graders.find((item) => item.id === criterion.graderId);
      return criterion.source === "deterministic" && grader?.config.kind === "trace";
    });
    if (traceCriteria.length > 0 && !trace) return null;
    const experiment = this.store.getExperiment(run.experimentId);
    const judgeCriteria = manifest.criteria.filter((criterion) => criterion.source === "judge");
    const judgeExpected = Boolean(experiment?.config.autoJudge && judgeCriteria.length > 0);
    const judge = judgeFromRecords(records);
    if (judgeExpected && !judge) return null;
    const deterministic: Record<string, GraderOutcome> = {};
    for (const criterion of manifest.criteria.filter((item) => item.source === "deterministic")) {
      const grader = manifest.graders.find((item) => item.id === criterion.graderId);
      if (!grader) {
        deterministic[criterion.id] = { passed: false, reason: `缺少 grader：${criterion.graderId}`, evidence: [] };
        continue;
      }
      if (grader.config.kind === "trace") {
        if (!trace) continue;
        deterministic[criterion.id] = runTraceGrader(
          grader,
          trace,
          observationForRun(trace, run, this.store.getRunMetrics(run.id), this.now()) ?? undefined
        );
        continue;
      }
      try {
        deterministic[criterion.id] = runGrader(grader, artifacts);
      } catch (error) {
        deterministic[criterion.id] = { passed: false, reason: error instanceof Error ? error.message : String(error), evidence: [] };
      }
    }
    const changedCriteria = Object.entries(stored)
      .filter(([id, outcome]) => deterministic[id] && deterministic[id].passed !== outcome.passed)
      .map(([id]) => id);
    const observation = observationForRun(trace, run, this.store.getRunMetrics(run.id), this.now());
    const outcome = scoreRun({
      manifest,
      deterministic,
      judge,
      judgeExpected,
      humanDecision: this.store.getHumanReview(run.id)?.decision ?? null,
      reviewReasonSeed: run.id,
      runFailed: false,
      sampleRate: 0,
      gates: gateOutcomes(manifest, deterministic, judge),
      budgetViolations: budgetViolations(manifest, observation)
    });
    return { outcome, deterministicChanged: changedCriteria.length > 0, changedCriteria };
  }

  private readArtifacts(outputDir: string): ArtifactMap {
    const root = resolveRunOutputDir(this.repoRoot, this.artifactRoot, outputDir);
    if (!isPathInside(this.artifactRoot, root) || !existsSync(root)) return {};
    const artifacts: ArtifactMap = {};
    const visit = (directory: string, depth: number) => {
      if (depth > 12 || Object.keys(artifacts).length >= 500) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || Object.keys(artifacts).length >= 500) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const stats = statSync(absolute);
        if (stats.size > 20 * 1024 * 1024) continue;
        artifacts[absolute.slice(root.length + 1).replace(/\\/g, "/")] = {
          text: stats.size <= 1_000_000 ? readFileSync(absolute, "utf8") : "",
          bytes: stats.size
        };
      }
    };
    visit(root, 0);
    return artifacts;
  }

  review(runId: string, decision: "pass" | "fail" | "unknown", reviewer = "local", note = ""): HumanReviewRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new EvalRunnerError("RUN_NOT_FOUND", "评测运行不存在", 404);
    const loaded = this.catalog.get(run.caseKey);
    if (!loaded) throw new EvalRunnerError("CASE_NOT_FOUND", "评测 case 不存在", 404);
    const existing = this.store.listGraderResults(runId);
    const deterministic = deterministicFromRecords(existing);
    const judge = judgeFromRecords(existing);
    const judgeCriteria = loaded.manifest.criteria.filter((criterion) => criterion.source === "judge");
    const experiment = this.store.getExperiment(run.experimentId);
    const outcome = scoreRun({
      manifest: loaded.manifest,
      deterministic,
      judge,
      judgeExpected: experiment?.config.autoJudge === true && judgeCriteria.length > 0,
      humanDecision: decision,
      humanReviewed: decision !== "unknown",
      reviewReasonSeed: run.id,
      runFailed: ["failed", "error", "blocked"].includes(run.status),
      sampleRate: 0,
      priorReviewReasons: run.reviewReasons
    });
    const timestamp = this.now().toISOString();
    const review: HumanReviewRecord = {
      id: randomUUID(),
      runId,
      reviewer: reviewer.trim() || "local",
      decision,
      score: outcome.humanScore,
      note: note.trim(),
      createdAt: this.store.getHumanReview(runId)?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    const humanCriteria = loaded.manifest.criteria.filter((criterion) => criterion.source === "human");
    const humanResults: GraderResultRecord[] = decision === "unknown" ? [] : humanCriteria.map((criterion) => ({
      id: randomUUID(),
      runId,
      criterionId: criterion.id,
      source: "human",
      passed: decision === "pass",
      score: decision === "pass" ? criterion.points : 0,
      confidence: 1,
      reason: note.trim() || (decision === "pass" ? "人工复核通过" : "人工复核未通过"),
      evidence: [],
      model: null,
      promptHash: null,
      createdAt: timestamp
    }));
    this.store.replaceGraderResults(runId, [...existing.filter((result) => result.source !== "human"), ...humanResults]);
    this.store.upsertHumanReview(review);
    const nextStatus: ExperimentRunStatus = outcome.verdict === "passed"
      ? "passed"
      : outcome.verdict === "failed"
        ? "failed"
        : "needs_review";
    this.store.updateRun(runId, {
      status: nextStatus,
      score: outcome.score,
      reviewReasons: outcome.reviewReasons,
      updatedAt: timestamp,
      ...(["passed", "failed"].includes(nextStatus) ? { finishedAt: run.finishedAt ?? timestamp } : {})
    });
    this.store.appendEvent("review.submitted", {
      experimentId: run.experimentId,
      runId,
      payload: { decision, reviewer: review.reviewer, status: nextStatus, score: outcome.score }
    });
    this.refreshExperiment(run.experimentId);
    return review;
  }

  refreshExperiment(experimentId: string): ExperimentRecord | null {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment || experiment.status === "cancelled") return experiment;
    const runs = this.store.listRuns(experimentId);
    const summary = this.summarize(experimentId);
    const terminal = runs.every((run) => !["queued", "created", "running", "waiting", "grading"].includes(run.status));
    const pendingReview = runs.some((run) => run.reviewReasons.length > 0 && !this.store.getHumanReview(run.id));
    const allError = runs.length > 0 && runs.every((run) => run.status === "error");
    const status = terminal
      ? pendingReview
        ? "needs_review"
        : allError
          ? "failed"
          : "completed"
      : "running";
    return this.store.updateExperiment(experimentId, {
      status,
      summary,
      ...(terminal ? { finishedAt: experiment.finishedAt ?? this.now().toISOString() } : {})
    });
  }

  async resumeInterruptedRuns(): Promise<RecoverySummary> {
    const summary = this.store.recoverInterrupted({ staleAfterMs: this.recoveryStaleMs });
    const grouped = new Map<string, ExperimentRunRecord[]>();
    for (const run of this.store.listRecoverableRuns()) {
      grouped.set(run.experimentId, [...(grouped.get(run.experimentId) ?? []), run]);
    }
    await Promise.all([...grouped].map(([experimentId, runs]) => this.resumeExperiment(experimentId, runs)));
    return summary;
  }

  private async resumeExperiment(experimentId: string, runs: ExperimentRunRecord[]): Promise<void> {
    if (this.active.has(experimentId)) return;
    this.active.add(experimentId);
    try {
      const experiment = this.store.getExperiment(experimentId);
      if (!experiment || experiment.status === "cancelled") return;
      this.store.updateExperiment(experimentId, {
        status: "running",
        startedAt: experiment.startedAt ?? this.now().toISOString(),
        finishedAt: null
      });
      this.store.appendEvent("experiment.resumed", { experimentId, payload: { runCount: runs.length } });
      let cursor = 0;
      const workers = Array.from({ length: Math.min(experiment.config.maxConcurrency, Math.max(1, runs.length)) }, async () => {
        while (cursor < runs.length) {
          const run = runs[cursor];
          cursor += 1;
          if (!run) break;
          if (this.store.getExperiment(experimentId)?.status === "cancelled") return;
          await this.executeRun(run);
          this.refreshExperiment(experimentId);
        }
      });
      await Promise.all(workers);
      this.refreshExperiment(experimentId);
    } finally {
      this.active.delete(experimentId);
    }
  }

  private async runExperiment(experimentId: string): Promise<void> {
    let experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new EvalRunnerError("EXPERIMENT_NOT_FOUND", "实验不存在", 404);
    if (experiment.status === "cancelled") return;
    experiment = this.store.updateExperiment(experimentId, {
      status: "running",
      startedAt: experiment.startedAt ?? this.now().toISOString()
    }) ?? experiment;
    this.store.appendEvent("experiment.started", { experimentId, payload: { runCount: this.store.listRuns(experimentId).length } });

    const queued = this.store.listQueuedRuns(experimentId);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(experiment.config.maxConcurrency, Math.max(1, queued.length)) }, async () => {
      while (cursor < queued.length) {
        const run = queued[cursor];
        cursor += 1;
        if (!run) break;
        if (this.store.getExperiment(experimentId)?.status === "cancelled") return;
        await this.executeRun(run);
        this.refreshExperiment(experimentId);
        if (this.enforceExperimentBudget(experimentId)) return;
      }
    });
    await Promise.all(workers);
    this.refreshExperiment(experimentId);
  }

  /** Stop launching new runs once the experiment-level USD budget is exceeded. */
  private enforceExperimentBudget(experimentId: string): boolean {
    const experiment = this.store.getExperiment(experimentId);
    const maxCostUsd = experiment?.config.maxCostUsd;
    if (!experiment || maxCostUsd === undefined) return false;
    const runs = this.store.listRuns(experimentId);
    const total = runs.reduce((sum, run) => sum + (this.store.getRunMetrics(run.id)?.costUsd ?? 0), 0);
    if (total <= maxCostUsd) return false;
    const queued = this.store.listQueuedRuns(experimentId);
    for (const run of queued) {
      this.store.updateRun(run.id, {
        status: "blocked",
        finishedAt: this.now().toISOString(),
        error: `实验 USD 预算已用尽：$${total.toFixed(2)} / $${maxCostUsd.toFixed(2)}`,
        primaryCause: "unknown"
      });
    }
    this.store.appendEvent("experiment.budget_blocked", {
      experimentId,
      payload: { totalUsd: total, maxCostUsd, blockedRuns: queued.length }
    });
    return true;
  }

  private async executeRun(run: ExperimentRunRecord): Promise<void> {
    const loaded = this.catalog.get(run.caseKey);
    if (!loaded) {
      this.finishRunError(run, "CASE_NOT_FOUND", "评测 case 不存在");
      return;
    }
    const manifest = loaded.manifest;
    const startedAt = this.now().toISOString();
    try {
      if (run.hearthTaskId && ["running", "waiting", "grading"].includes(run.status)) {
        this.store.updateRun(run.id, {
          status: "running",
          startedAt: run.startedAt ?? startedAt,
          error: null,
          updatedAt: startedAt
        });
        this.store.appendEvent("run.recovered", {
          experimentId: run.experimentId,
          runId: run.id,
          payload: { hearthTaskId: run.hearthTaskId, previousStatus: run.status }
        });
        await this.finishTask(run, manifest, run.hearthTaskId);
        return;
      }
      this.store.updateRun(run.id, { status: "created", startedAt, updatedAt: startedAt });
      this.store.appendEvent("run.created", {
        experimentId: run.experimentId,
        runId: run.id,
        payload: { caseKey: run.caseKey, executorId: run.executorId, repetition: run.repetition }
      });
      const created = await this.client.createTask(this.buildTaskRequest(run, loaded));
      run.hearthTaskId = created.task.id;
      this.store.updateRun(run.id, { status: "running", hearthTaskId: created.task.id, updatedAt: this.now().toISOString() });
      this.store.appendEvent("run.task-created", {
        experimentId: run.experimentId,
        runId: run.id,
        payload: { hearthTaskId: created.task.id, created: created.created }
      });
      await this.finishTask(run, manifest, created.task.id);
    } catch (error) {
      this.finishRunError(run, "RUN_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async finishTask(run: ExperimentRunRecord, manifest: CaseManifest, taskId: string): Promise<void> {
    const wait = await this.waitForTask({ ...run, hearthTaskId: taskId }, manifest);
    const trace = await this.captureTrace(run, taskId, wait).catch(() => null);
    this.store.updateRun(run.id, { status: "grading", updatedAt: this.now().toISOString() });
    this.store.appendEvent("run.grading", {
      experimentId: run.experimentId,
      runId: run.id,
      payload: { taskStatus: wait.status }
    });
    const artifacts = await this.client.getArtifacts({ taskId, outputDir: run.outputDir });
    const graded = await this.gradeRun(run, manifest, artifacts, wait, trace);
    let cost: { usd: number | null; pricingSnapshotId: string | null; breakdown?: Record<string, unknown> | null } | null = null;
    if (this.client.getCost) {
      try {
        cost = await this.client.getCost(taskId);
      } catch {
        cost = null;
      }
    }
    this.store.setRunMetrics(run.id, metricsFromView(wait.view, cost));
    const finishedAt = this.now().toISOString();
    const runFailed = wait.status !== "completed";
    const status = runStatusFor(wait, graded, runFailed);
    this.store.updateRun(run.id, {
      status,
      score: graded.outcome.score,
      primaryCause: trace?.primaryCause ?? null,
      reviewReasons: graded.outcome.reviewReasons,
      error: runError(wait, graded),
      finishedAt,
      updatedAt: finishedAt
    });
    this.store.appendEvent("run.finished", {
      experimentId: run.experimentId,
      runId: run.id,
      payload: {
        status,
        score: graded.outcome.score,
        verdict: graded.outcome.verdict,
        reviewReasons: graded.outcome.reviewReasons,
        taskStatus: wait.status
      }
    });
  }

  private buildTaskRequest(run: ExperimentRunRecord, loaded: LoadedCase) {
    const manifest = loaded.manifest;
    const experiment = this.store.getExperiment(run.experimentId);
    const runMode = experiment?.config.runMode ?? "offline";
    const inputs = (runMode === "live" ? manifest.liveInputs ?? manifest.inputs : manifest.inputs)
      .map((input) => this.toTaskInput(loaded, input));
    return {
      externalRef: run.externalRef,
      title: `${manifest.id} · ${manifest.title}`,
      goal: manifest.goal,
      inputs,
      expectedOutputs: manifest.expectedOutputs,
      executorId: run.executorId,
      runMode,
      networkHosts: runMode === "live" ? manifest.networkHosts ?? [] : [],
      outputDir: run.outputDir,
      timeoutMs: manifest.timeoutMs,
      ...(experiment?.config.harnessVariantId ? { harnessVariantId: experiment.config.harnessVariantId } : {})
    };
  }

  private toTaskInput(loaded: LoadedCase, input: EvalInput): { kind: "file" | "url"; label: string; value: string } {
    if (input.kind === "url") return { kind: "url", label: input.label, value: input.value ?? "" };
    const value = input.path ?? input.value ?? "";
    const absolute = resolveCaseInput(this.repoRoot, loaded.directory, value);
    return { kind: "file", label: input.label, value: absolute };
  }

  private async waitForTask(run: ExperimentRunRecord, manifest: CaseManifest): Promise<TaskWaitResult> {
    if (!run.hearthTaskId) throw new Error("评测运行缺少 Hearth 任务 ID");
    const deadline = Date.now() + manifest.timeoutMs + 120_000;
    let last: AgentTaskView | null = null;
    let previousProgress = "";
    while (Date.now() < deadline) {
      const view = await this.client.getTask(run.hearthTaskId);
      last = view;
      const status = view.task.status;
      if (isTerminalTaskStatus(status)) return { status, task: view.task, view, timedOut: false };
      if (this.store.getRun(run.id)?.status === "cancelled") return { status: "cancelled", task: view.task, view, timedOut: false };
      const nextAction = view.task.nextAction ?? null;
      const progress = JSON.stringify([status, nextAction]);
      if (progress !== previousProgress) {
        previousProgress = progress;
        const waiting = ["waiting_approval", "waiting_input", "recoverable"].includes(status);
        this.store.updateRun(run.id, {
          status: waiting ? "waiting" : "running",
          error: waiting ? "任务正在等待人工审批、输入或恢复" : null,
          updatedAt: this.now().toISOString()
        });
        this.store.appendEvent(waiting ? "run.waiting" : "run.progress", {
          experimentId: run.experimentId, runId: run.id, payload: { status, nextAction }
        });
      }
      await this.sleep(this.pollIntervalMs);
    }
    const task = last?.task ?? { id: run.hearthTaskId, status: "running" };
    return { status: "timeout", task, view: last, timedOut: true };
  }

  private async captureTrace(run: ExperimentRunRecord, taskId: string, wait: TaskWaitResult): Promise<EvalTrace> {
    const raw = this.client.getTrace
      ? await this.client.getTrace(taskId)
      : buildEvalTrace(taskId, (wait.view?.events ?? []) as RawTraceEvent[], {});
    const trace: EvalTrace = {
      ...raw,
      primaryCause: attributePrimaryCause(raw.events, {
        taskStatus: wait.status,
        timedOut: wait.timedOut,
        error: wait.task.error?.message ?? null
      })
    };
    this.store.saveTrace(run.id, trace);
    this.store.appendEvent("run.trace", {
      experimentId: run.experimentId,
      runId: run.id,
      payload: {
        taskId,
        steps: trace.steps,
        events: trace.events.length,
        primaryCause: trace.primaryCause,
        truncated: trace.truncated
      }
    });
    return trace;
  }

  private async gradeRun(
    run: ExperimentRunRecord,
    manifest: CaseManifest,
    artifacts: ArtifactMap,
    wait: TaskWaitResult,
    trace: EvalTrace | null
  ): Promise<GradeResult> {
    const deterministic: Record<string, GraderOutcome> = {};
    const graderRecords: GraderResultRecord[] = [];
    const createdAt = this.now().toISOString();
    const tokens = (wait.view?.runs ?? []).reduce(
      (sum, item) => sum + (item.usage?.inputTokens ?? 0) + (item.usage?.outputTokens ?? 0),
      0
    );
    const durationMs = run.startedAt ? Math.max(0, Date.parse(createdAt) - Date.parse(run.startedAt)) : null;
    const observed = trace ? observeTrace(trace, { durationMs, tokens }) : null;
    for (const criterion of manifest.criteria.filter((item) => item.source === "deterministic")) {
      const grader = manifest.graders.find((item) => item.id === criterion.graderId);
      let result: GraderOutcome;
      if (!grader) {
        result = { passed: false, reason: `缺少 grader：${criterion.graderId}`, evidence: [] };
      } else if (grader.config.kind === "trace") {
        if (!trace || !observed) {
          graderRecords.push({
            id: randomUUID(),
            runId: run.id,
            criterionId: criterion.id,
            source: "deterministic",
            passed: null,
            score: null,
            confidence: null,
            reason: "轨迹不可用，无法执行门禁",
            evidence: [],
            model: null,
            promptHash: null,
            createdAt
          });
          continue;
        }
        result = runTraceGrader(grader, trace, observed);
      } else {
        try {
          result = runGrader(grader, artifacts);
        } catch (error) {
          result = { passed: false, reason: error instanceof Error ? error.message : String(error), evidence: [] };
        }
      }
      deterministic[criterion.id] = result;
      graderRecords.push({
        id: randomUUID(),
        runId: run.id,
        criterionId: criterion.id,
        source: "deterministic",
        passed: result.passed,
        score: result.passed ? 100 : 0,
        confidence: null,
        reason: result.reason,
        evidence: result.evidence,
        model: null,
        promptHash: null,
        createdAt
      });
    }

    const experiment = this.store.getExperiment(run.experimentId);
    const judgeCriteria = manifest.criteria.filter((item) => item.source === "judge");
    const judgeExpected = experiment?.config.autoJudge === true && judgeCriteria.length > 0;
    let judge: JudgeOutcome | null = null;
    if (judgeExpected) {
      const response = await this.requestJudge(run, manifest, artifacts, deterministic, experiment?.config.autoRetry === true);
      if (response) {
        judge = {
          criteria: Object.fromEntries(response.criteria.map((item) => [item.id, {
            passed: item.passed,
            confidence: item.confidence,
            reason: item.reason
          }])) as JudgeOutcome["criteria"],
          overallConfidence: response.overallConfidence
        };
        for (const criterion of judgeCriteria) {
          const item = response.criteria.find((candidate) => candidate.id === criterion.id);
          if (!item) continue;
          graderRecords.push(judgeRecord(run.id, criterion.id, item, response.model, response.promptHash, createdAt));
        }
      }
    }
    this.store.replaceGraderResults(run.id, graderRecords);
    const sharedGate = await this.sharedVerificationGate(run, manifest, artifacts);
    const outcome = scoreRun({
      manifest,
      deterministic,
      judge,
      judgeExpected,
      humanDecision: null,
      reviewReasonSeed: run.id,
      runFailed: wait.status !== "completed",
      sampleRate: manifest.humanReview.sampleRate,
      gates: [...gateOutcomes(manifest, deterministic, judge), ...(sharedGate ? [sharedGate] : [])],
      budgetViolations: budgetViolations(manifest, observed)
    });
    if (outcome.gateWarnings.length > 0) {
      this.store.appendEvent("run.gate-warning", {
        experimentId: run.experimentId,
        runId: run.id,
        payload: { warnings: outcome.gateWarnings }
      });
    }
    return { graderRecords, deterministic, judge, judgeExpected, outcome };
  }

  /**
   * Execute the deterministic subset of the shared VerificationSpec with the
   * same primitives the OS uses for production completion. Trace/judge/human
   * units stay in their native layers: they need exchanges, calibrated judges
   * and reviewers that the eval aggregation owns.
   */
  private async sharedVerificationGate(
    run: ExperimentRunRecord,
    manifest: CaseManifest,
    artifacts: ArtifactMap
  ): Promise<GateOutcomeInput | null> {
    const VERIFIABLE = new Set(["file_exists", "text_contains", "json", "csv", "schema", "artifact"]);
    const spec = compileCaseVerification(manifest);
    const units = spec.units.filter((unit) => VERIFIABLE.has(unit.type));
    if (units.length === 0) return null;
    const workspaceRoot = resolveRunOutputDir(this.repoRoot, this.artifactRoot, run.outputDir);
    if (!existsSync(workspaceRoot) || Object.keys(artifacts).length === 0) return null;
    const artifactRecords = Object.entries(artifacts).map(([relativePath, value]) => ({
      relativePath,
      absolutePath: resolve(workspaceRoot, relativePath),
      sha256: "",
      bytes: value.bytes,
      mimeType: "application/octet-stream"
    }));
    try {
      const result = await runVerificationSpec({ ...spec, units }, {
        workspaceRoot,
        outDir: workspaceRoot,
        artifacts: artifactRecords,
        now: this.now
      });
      this.store.appendEvent("run.shared-verification", {
        experimentId: run.experimentId,
        runId: run.id,
        payload: {
          specId: spec.id,
          units: result.units.map((unit) => ({ id: unit.id, type: unit.type, status: unit.status })),
          verdict: result.verdict
        }
      });
      return {
        id: "shared-verification",
        layer: "result",
        severity: "blocker",
        passed: result.verdict === "pass" ? true : result.verdict === "fail" ? false : null,
        reason: result.verdict === "pass"
          ? `共享 Verifier 通过（${units.length} 个确定性单元）`
          : result.verdict === "fail"
            ? `共享 Verifier 失败：${result.units.filter((unit) => unit.status === "fail").map((unit) => unit.id).join(", ")}`
            : "共享 Verifier 证据不足，需人工复核"
      };
    } catch (error) {
      this.store.appendEvent("run.shared-verification-error", {
        experimentId: run.experimentId,
        runId: run.id,
        payload: { error: error instanceof Error ? error.message : String(error) }
      });
      return null;
    }
  }

  private async requestJudge(
    run: ExperimentRunRecord,
    manifest: CaseManifest,
    artifacts: ArtifactMap,
    deterministic: Record<string, GraderOutcome>,
    autoRetry: boolean
  ): Promise<{ criteria: JudgeCriterionResult[]; overallConfidence: number; model: string; promptHash: string } | null> {
    if (!this.judge) {
      this.store.appendEvent("run.judge-unavailable", {
        experimentId: run.experimentId, runId: run.id, payload: { error: "未配置评委适配器" }
      });
      return null;
    }
    const criteria = manifest.criteria.filter((item) => item.source === "judge").map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      rubric: criterion.rubric ?? criterion.label,
      points: criterion.points
    }));
    const attempts = autoRetry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.judge.judge({
          artifacts,
          ...(run.hearthTaskId ? { taskId: run.hearthTaskId } : {}),
          criteria,
          deterministic: manifest.criteria
            .filter((item) => item.source === "deterministic")
            .map((criterion) => ({
              criterionId: criterion.id,
              passed: deterministic[criterion.id]?.passed === true,
              reason: deterministic[criterion.id]?.reason ?? "未执行"
            }))
        });
        if (response.diagnostics) {
          this.store.appendEvent("run.judge-response", {
            experimentId: run.experimentId, runId: run.id, payload: response.diagnostics
          });
        }
        return response;
      } catch (error) {
        const exhausted = attempt + 1 >= attempts;
        this.store.appendEvent(exhausted ? "run.judge-unavailable" : "run.judge-retry", {
          experimentId: run.experimentId,
          runId: run.id,
          payload: {
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && "diagnostics" in error ? { diagnostics: error.diagnostics } : {})
          }
        });
        if (exhausted) return null;
      }
    }
    return null;
  }

  private finishRunError(run: ExperimentRunRecord, code: string, message: string): void {
    const finishedAt = this.now().toISOString();
    this.store.updateRun(run.id, {
      status: "error",
      error: `${code}: ${message}`,
      reviewReasons: ["failed_sample"],
      finishedAt,
      updatedAt: finishedAt
    });
    this.store.appendEvent("run.error", {
      experimentId: run.experimentId,
      runId: run.id,
      payload: { code, message }
    });
    this.refreshExperiment(run.experimentId);
  }
}

function supportsRunMode(manifest: CaseManifest, mode: "offline" | "live"): boolean {
  return mode === "offline"
    ? manifest.runModes.some((item) => item !== "live-only")
    : manifest.runModes.some((item) => item === "live-only" || item === "live-optional");
}

function runStatusFor(wait: TaskWaitResult, graded: GradeResult, runFailed: boolean): ExperimentRunStatus {
  if (wait.status === "cancelled") return "cancelled";
  if (wait.timedOut) return "blocked";
  if (graded.outcome.verdict === "needs_review") return "needs_review";
  if (graded.outcome.verdict === "failed" || runFailed) return "failed";
  return "passed";
}

function runError(wait: TaskWaitResult, graded: GradeResult): string | null {
  if (wait.timedOut) return "TASK_TIMEOUT: 任务在评测超时前未结束";
  const taskError = wait.task.error?.message;
  if (wait.status !== "completed") return taskError ? `${wait.status}: ${taskError}` : `任务状态：${wait.status}`;
  if (graded.outcome.blockerFailures.length > 0) return `BLOCKER_FAILED: ${graded.outcome.blockerFailures.join(", ")}`;
  return null;
}

function judgeRecord(
  runId: string,
  criterionId: string,
  result: JudgeCriterionResult,
  model: string,
  promptHash: string,
  createdAt: string
): GraderResultRecord {
  return {
    id: randomUUID(),
    runId,
    criterionId,
    source: "judge",
    passed: result.passed,
    score: result.passed ? 100 : 0,
    confidence: result.confidence,
    reason: result.reason,
    evidence: result.evidence,
    model,
    promptHash,
    createdAt
  };
}

function deterministicFromRecords(records: GraderResultRecord[]): Record<string, GraderOutcome> {
  return Object.fromEntries(records
    .filter((record) => record.source === "deterministic")
    .map((record) => [record.criterionId, { passed: record.passed === true, reason: record.reason, evidence: record.evidence }]));
}

function judgeFromRecords(records: GraderResultRecord[]): JudgeOutcome | null {
  const judgeRecords = records.filter((record) => record.source === "judge");
  if (judgeRecords.length === 0) return null;
  const criteria = Object.fromEntries(judgeRecords.map((record) => [record.criterionId, {
    passed: record.passed === true,
    confidence: record.confidence ?? 0,
    reason: record.reason
  }]));
  return {
    criteria,
    overallConfidence: judgeRecords.reduce((sum, record) => sum + (record.confidence ?? 0), 0) / judgeRecords.length
  };
}

function metricsFromView(
  view: AgentTaskView | null,
  cost: { usd: number | null; pricingSnapshotId: string | null; breakdown?: Record<string, unknown> | null } | null = null
): RunMetrics {
  const runs = view?.runs ?? [];
  return {
    inputTokens: runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, run) => sum + (run.usage?.outputTokens ?? 0), 0),
    retryCount: runs.reduce((sum, run) => sum + Math.max(0, run.attempt - 1), 0),
    approvalCount: view?.approvals?.length ?? 0,
    costUsd: cost?.usd ?? null,
    pricingSnapshotId: cost?.pricingSnapshotId ?? null,
    costBreakdown: cost?.breakdown ?? null
  };
}

function gateOutcomes(
  manifest: CaseManifest,
  deterministic: Record<string, GraderOutcome>,
  judge: JudgeOutcome | null
): GateOutcomeInput[] {
  return manifest.criteria
    .filter((criterion) => (criterion.layer ?? "result") !== "result")
    .map((criterion) => {
      const layer = (criterion.layer ?? "result") as GateLayer;
      if (criterion.source === "deterministic") {
        const outcome = deterministic[criterion.id];
        return {
          id: criterion.id,
          layer,
          severity: criterion.severity,
          passed: outcome ? outcome.passed : null,
          reason: outcome?.reason ?? "缺少证据"
        };
      }
      if (criterion.source === "judge") {
        const item = judge?.criteria[criterion.id];
        return {
          id: criterion.id,
          layer,
          severity: criterion.severity,
          passed: item ? item.passed : null,
          reason: item?.reason ?? "缺少裁判结果"
        };
      }
      return { id: criterion.id, layer, severity: criterion.severity, passed: null, reason: "需要人工判断" };
    });
}

function budgetViolations(manifest: CaseManifest, observed: TraceObservation | null): string[] {
  const budgets = manifest.budgets;
  if (!budgets || !observed) return [];
  const violations: string[] = [];
  if (budgets.maxSteps !== undefined && observed.steps > budgets.maxSteps) violations.push("budget.maxSteps");
  if (budgets.maxToolCalls !== undefined && observed.toolCalls > budgets.maxToolCalls) violations.push("budget.maxToolCalls");
  if (budgets.maxDurationMs !== undefined && observed.durationMs !== null && observed.durationMs > budgets.maxDurationMs) {
    violations.push("budget.maxDurationMs");
  }
  if (budgets.maxTokens !== undefined && observed.tokens !== null && observed.tokens > budgets.maxTokens) {
    violations.push("budget.maxTokens");
  }
  if (budgets.maxCostUsd !== undefined) {
    if (observed.costUsd === null || observed.costUsd === undefined) {
      // Missing price is not zero: surface it as a budget violation with an
      // explicit reason so a blocker is never silently skipped.
      violations.push("budget.maxCostUsd.unpriced");
    } else if (observed.costUsd > budgets.maxCostUsd) {
      violations.push("budget.maxCostUsd");
    }
  }
  return violations;
}

function costSummaryFor(runs: ExperimentRunRecord[], metrics: Array<RunMetrics | null>): ExperimentCostSummary | null {
  if (runs.length === 0) return null;
  const pairs = runs.map((run, index) => ({ run, metric: metrics[index] ?? null }));
  const priced = pairs.filter((item) => item.metric?.costUsd !== null && item.metric?.costUsd !== undefined);
  if (priced.length === 0) {
    return {
      totalUsd: 0,
      pricedRuns: 0,
      unpricedRuns: runs.length,
      avgUsdPerRun: null,
      costPerVerifiedCompletion: null,
      failedUsd: 0,
      retryIncrementUsd: 0,
      pricingSnapshotIds: [],
      byExecutor: []
    };
  }
  const totalUsd = priced.reduce((sum, item) => sum + (item.metric?.costUsd ?? 0), 0);
  const passed = runs.filter((run) => run.status === "passed").length;
  const failedUsd = priced
    .filter((item) => item.run.status === "failed" || item.run.status === "error" || item.run.status === "blocked")
    .reduce((sum, item) => sum + (item.metric?.costUsd ?? 0), 0);
  const retryIncrementUsd = priced.reduce((sum, item) => {
    const breakdown = item.metric?.costBreakdown ?? null;
    const retry = breakdown && typeof breakdown.retryUsd === "number" ? breakdown.retryUsd : 0;
    return sum + retry;
  }, 0);
  const byExecutor = new Map<string, { usd: number; runs: number }>();
  for (const item of pairs) {
    const existing = byExecutor.get(item.run.executorId) ?? { usd: 0, runs: 0 };
    existing.runs += 1;
    existing.usd += item.metric?.costUsd ?? 0;
    byExecutor.set(item.run.executorId, existing);
  }
  return {
    totalUsd: round(totalUsd),
    pricedRuns: priced.length,
    unpricedRuns: runs.length - priced.length,
    avgUsdPerRun: round(totalUsd / priced.length),
    costPerVerifiedCompletion: passed > 0 ? round(totalUsd / passed) : null,
    failedUsd: round(failedUsd),
    retryIncrementUsd: round(retryIncrementUsd),
    pricingSnapshotIds: [...new Set(priced.map((item) => item.metric?.pricingSnapshotId ?? "").filter(Boolean))],
    byExecutor: [...byExecutor.entries()].map(([executorId, value]) => ({ executorId, usd: round(value.usd), runs: value.runs }))
  };
}

function variantSummaryFor(
  experiment: ExperimentRecord,
  runs: ExperimentRunRecord[],
  metrics: Array<RunMetrics | null>
): VariantExperimentSummary | null {
  const variantId = experiment.config.harnessVariantId ?? "baseline";
  if (runs.length === 0) return null;
  const passed = runs.filter((run) => run.status === "passed").length;
  const scores = runs.flatMap((run) => run.score === null ? [] : [run.score]);
  const durations = runs.flatMap((run) => run.startedAt && run.finishedAt
    ? [Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))]
    : []);
  const totalUsd = metrics.reduce((sum, metric) => sum + (metric?.costUsd ?? 0), 0);
  return {
    harnessVariantId: variantId,
    totalRuns: runs.length,
    passed,
    passRate: round(passed / runs.length * 100),
    avgScore: scores.length === 0 ? null : round(scores.reduce((sum, value) => sum + value, 0) / scores.length),
    totalUsd: round(totalUsd),
    avgDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    wilson95: wilsonInterval(passed, runs.length)
  };
}

function diagnosticGroups(runs: ExperimentRunRecord[]): ExperimentSummary["failureDiagnostics"] {
  const groups = new Map<string, string[]>();
  for (const run of runs) {
    if (!["failed", "blocked", "error"].includes(run.status)) continue;
    const kind = run.error?.split(":")[0]?.trim() || run.status;
    const ids = groups.get(kind) ?? [];
    ids.push(run.id);
    groups.set(kind, ids);
  }
  return [...groups.entries()].map(([kind, runIds]) => ({ kind, count: runIds.length, runIds }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function runKey(run: ExperimentRunRecord): string {
  return `${run.caseKey}\u0000${run.executorId}\u0000${run.repetition}`;
}

function observationForRun(
  trace: EvalTrace | null,
  run: ExperimentRunRecord,
  metrics: RunMetrics | null,
  now: Date
): TraceObservation | null {
  const durationMs = run.startedAt
    ? Math.max(0, Date.parse(run.finishedAt ?? now.toISOString()) - Date.parse(run.startedAt))
    : null;
  const tokens = metrics ? metrics.inputTokens + metrics.outputTokens : null;
  const costUsd = metrics?.costUsd ?? null;
  if (!trace && durationMs === null && tokens === null) return null;
  return {
    steps: trace?.steps ?? 0,
    toolCalls: trace?.toolCalls ?? 0,
    approvals: trace?.approvals ?? 0,
    effects: trace?.effects ?? 0,
    errors: trace?.errors.length ?? 0,
    durationMs,
    tokens,
    costUsd,
    pricingSnapshotId: metrics?.pricingSnapshotId ?? null
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}
