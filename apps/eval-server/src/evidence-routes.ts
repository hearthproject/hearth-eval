// Versioned evidence/replay API exposed by Hearth Eval.
//
// These routes are a thin, validating facade over the OS evidence plane plus
// evaluation-owned artifacts (compiled regressions, experiment manifests, gate
// reports). They never read the OS database directly.
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  advanceReproduction,
  buildExperimentManifest,
  compileFailureToCase,
  DEFAULT_REGRESSION_GATE,
  evaluateRegressionGate,
  experimentDiff,
  parseExperimentManifest,
  parseRuntimeManifest,
  regressionStatsFromRuns,
  selectStableSubset,
  compareVariants,
  type ExperimentManifest,
  type FailureCaseBundle,
  type ReproductionContract,
  type VerificationSpec
} from "@hearth/eval-core";
import { POLICY_CORPUS, runPolicyCorpus, comparePolicyPreflights, type PolicyCorpusCase, type PolicySpecLike } from "./policy-corpus.ts";
import type { ArtifactMap } from "@hearth/eval-core";
import type { LoadedCase } from "@hearth/eval-core/node";
import type { EvalStore } from "./store.ts";
import type { EvidenceClient } from "./evidence-client.ts";
import { compileCaseVerification, verifyCase } from "./verification-adapter.ts";
import { forkAtCheckpoint, loadRunEvidence, replayRun } from "./runtime-replay.ts";

const replaySchema = z.object({
  runId: z.string().trim().min(1).max(200),
  cassetteId: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(["strict_replay", "live_on_divergence"]).optional(),
  replacement: z.object({ exchangeId: z.string().min(1), output: z.unknown() }).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional()
}).strict();

const forkSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  checkpointSeq: z.number().int().min(0).optional(),
  replacement: z.object({ exchangeId: z.string().min(1), output: z.unknown() }).optional(),
  label: z.string().trim().max(120).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional()
}).strict();

const compileFailureSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  taskId: z.string().trim().min(1).max(200),
  caseId: z.string().trim().max(100).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(20_000),
  family: z.enum(["email", "calendar", "documents", "research", "code", "web", "desktop", "cross-app", "operations", "memory"]).optional(),
  difficulty: z.enum(["normal", "edge", "failure", "adversarial"]).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  inputs: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  artifacts: z.array(z.object({
    relativePath: z.string().min(1).max(500),
    sha256: z.string().max(100).nullable().optional(),
    bytes: z.number().int().min(0).nullable().optional()
  })).max(200).optional(),
  expectedOutputs: z.array(z.string().min(1).max(500)).max(100).optional(),
  primaryCause: z.string().max(120).nullable().optional(),
  observed: z.object({
    steps: z.number().int().min(0).optional(),
    toolCalls: z.number().int().min(0).optional(),
    approvals: z.number().int().min(0).optional(),
    effects: z.number().int().min(0).optional(),
    durationMs: z.number().min(0).nullable().optional(),
    tokens: z.number().min(0).nullable().optional()
  }).optional()
}).strict();

const advanceSchema = z.object({
  stage: z.enum(["baseline", "patched", "approve", "reject"]),
  experimentId: z.string().trim().max(100).optional(),
  runId: z.string().trim().max(100).optional(),
  verdict: z.enum(["passed", "failed"]).optional(),
  reviewer: z.string().trim().min(1).max(80).optional(),
  reason: z.string().trim().max(2_000).optional()
}).strict();

const corpusSchema = z.object({
  taskId: z.string().trim().min(1).max(200),
  cases: z.array(z.object({ id: z.string().min(1) })).optional()
}).strict();

const policyCompareSchema = z.object({
  taskId: z.string().trim().min(1).max(200),
  left: z.record(z.string(), z.unknown()),
  right: z.record(z.string(), z.unknown()),
  actions: z.array(z.record(z.string(), z.unknown())).min(1).max(100)
}).strict();

const verifyCaseSchema = z.object({
  caseId: z.string().trim().min(1).max(100),
  workspaceRoot: z.string().trim().min(1).max(1_000).optional(),
  outDir: z.string().trim().min(1).max(1_000).optional(),
  preferOs: z.boolean().default(true)
}).strict();

const regressionGateSchema = z.object({
  baseline: z.object({
    experimentId: z.string().min(1),
    totalRuns: z.number().int().min(0),
    passed: z.number().int().min(0),
    passRate: z.number().nullable(),
    costPerVerifiedCompletion: z.number().nullable(),
    p95LatencyMs: z.number().nullable(),
    safetyBlockers: z.number().int().min(0),
    unexpectedNondeterminism: z.number().int().min(0),
    failedCaseIds: z.array(z.string()),
    manifestChangedComponents: z.array(z.string())
  }),
  candidate: z.object({
    experimentId: z.string().min(1),
    totalRuns: z.number().int().min(0),
    passed: z.number().int().min(0),
    passRate: z.number().nullable(),
    costPerVerifiedCompletion: z.number().nullable(),
    p95LatencyMs: z.number().nullable(),
    safetyBlockers: z.number().int().min(0),
    unexpectedNondeterminism: z.number().int().min(0),
    failedCaseIds: z.array(z.string()),
    manifestChangedComponents: z.array(z.string())
  }),
  config: z.object({
    maxPassRateDropPct: z.number().min(0).max(100),
    maxCostIncreasePct: z.number().min(0).max(10_000),
    maxP95LatencyIncreasePct: z.number().min(0).max(10_000),
    maxSafetyBlockers: z.number().int().min(0),
    maxUnexpectedNondeterminism: z.number().int().min(0),
    requireNewFailuresFixed: z.boolean(),
    requireManifestDiffOnCriticalChange: z.boolean()
  }).partial().optional()
}).strict();

export interface EvidenceRouteOptions {
  app: FastifyInstance;
  store: EvalStore;
  client: EvidenceClient;
  catalog: Map<string, LoadedCase>;
  repoRoot: string;
  artifactRoot: string;
}

export function registerEvidenceRoutes(app: FastifyInstance, options: Omit<EvidenceRouteOptions, "app">): void {
  const { store, client, catalog, repoRoot, artifactRoot } = options;

  app.get("/api/evidence/health", async (_request, reply) => {
    try {
      return reply.send({ ok: true, os: await client.health() });
    } catch (error) {
      return reply.code(502).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/evidence/runs/:runId/manifest", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      const raw = await client.manifest(runId);
      const parsed = parseRuntimeManifest(raw);
      if (!parsed.ok) return reply.code(502).send({ error: "INVALID_MANIFEST", errors: parsed.errors });
      return reply.send(parsed.manifest);
    } catch (error) {
      return reply.code(404).send({ error: "MANIFEST_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/evidence/runs/:runId/exchanges", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      return reply.send(await client.exchanges(runId));
    } catch (error) {
      return reply.code(404).send({ error: "EXCHANGES_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/evidence/runs/:runId/bundle", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const query = request.query as Record<string, unknown>;
    try {
      return reply.send(await loadRunEvidence(client, runId, typeof query.taskId === "string" ? query.taskId : null));
    } catch (error) {
      return reply.code(404).send({ error: "EVIDENCE_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/evidence/tasks/:taskId/graph", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return reply.send(await client.artifactGraph(taskId));
    } catch (error) {
      return reply.code(404).send({ error: "GRAPH_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/evidence/compare", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (typeof query.left !== "string" || typeof query.right !== "string") {
      return reply.code(400).send({ error: "LEFT_RIGHT_REQUIRED" });
    }
    try {
      return reply.send(await client.compare(query.left, query.right));
    } catch (error) {
      return reply.code(404).send({ error: "COMPARE_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/evidence/cost/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    try {
      return reply.send(await client.cost(taskId));
    } catch (error) {
      return reply.code(404).send({ error: "COST_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/evidence/replay", async (request, reply) => {
    const parsed = replaySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REPLAY_REQUEST", issues: parsed.error.issues });
    try {
      const summary = await replayRun(client, parsed.data.runId, {
        ...(parsed.data.cassetteId ? { cassetteId: parsed.data.cassetteId } : {}),
        ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
        ...(parsed.data.replacement ? { replacement: parsed.data.replacement } : {}),
        ...(parsed.data.timeoutMs ? { timeoutMs: parsed.data.timeoutMs } : {})
      });
      store.appendEvent("evidence.replay", { payload: { runId: summary.runId, class: summary.divergenceClass, strict: summary.strict } });
      return reply.send(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("strict replay") ? 409 : 502).send({ error: "REPLAY_FAILED", message });
    }
  });

  app.post("/api/evidence/fork", async (request, reply) => {
    const parsed = forkSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_FORK_REQUEST", issues: parsed.error.issues });
    try {
      const summary = await forkAtCheckpoint(client, {
        runId: parsed.data.runId,
        ...(parsed.data.checkpointSeq !== undefined ? { checkpointSeq: parsed.data.checkpointSeq } : {}),
        ...(parsed.data.replacement ? { replacement: parsed.data.replacement } : {}),
        ...(parsed.data.label ? { label: parsed.data.label } : {}),
        ...(parsed.data.timeoutMs ? { timeoutMs: parsed.data.timeoutMs } : {})
      });
      store.appendEvent("evidence.fork", { payload: { parentRunId: summary.parentRunId, forkRunId: summary.forkRunId } });
      return reply.send(summary);
    } catch (error) {
      return reply.code(409).send({ error: "FORK_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/evidence/verify-case", async (request, reply) => {
    const parsed = verifyCaseSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_VERIFY_REQUEST", issues: parsed.error.issues });
    const loaded = catalog.get(parsed.data.caseId);
    if (!loaded) return reply.code(404).send({ error: "CASE_NOT_FOUND" });
    const workspaceRoot = parsed.data.workspaceRoot ?? parsed.data.outDir ?? resolve(repoRoot, artifactRoot);
    const outcome = await verifyCase(
      loaded.manifest,
      { workspaceRoot, outDir: parsed.data.outDir ?? workspaceRoot },
      parsed.data.preferOs ? client : null
    );
    store.appendEvent("evidence.verification", {
      payload: { caseId: parsed.data.caseId, verdict: outcome.result.verdict, source: outcome.source, specDigest: outcome.specDigest }
    });
    return reply.send(outcome);
  });

  app.get("/api/evidence/verification-spec/:caseId", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const loaded = catalog.get(caseId);
    if (!loaded) return reply.code(404).send({ error: "CASE_NOT_FOUND" });
    return reply.send({ spec: compileCaseVerification(loaded.manifest) });
  });

  app.post("/api/evidence/policy/corpus", async (request, reply) => {
    const parsed = corpusSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CORPUS_REQUEST", issues: parsed.error.issues });
    const selected: PolicyCorpusCase[] = parsed.data.cases
      ? POLICY_CORPUS.filter((item) => parsed.data.cases?.some((entry: { id: string }) => entry.id === item.id))
      : POLICY_CORPUS;
    const report = await runPolicyCorpus(client, parsed.data.taskId, selected);
    store.appendEvent("policy.corpus", { payload: { taskId: parsed.data.taskId, failed: report.failed, blockers: report.safetyBlockers } });
    return reply.send(report);
  });

  app.post("/api/evidence/policy/compare", async (request, reply) => {
    const parsed = policyCompareSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_POLICY_COMPARE", issues: parsed.error.issues });
    const comparison = await comparePolicyPreflights(
      client,
      parsed.data.taskId,
      parsed.data.left as unknown as PolicySpecLike,
      parsed.data.right as unknown as PolicySpecLike,
      parsed.data.actions as unknown as Parameters<typeof comparePolicyPreflights>[4]
    );
    return reply.send(comparison);
  });

  app.post("/api/evidence/failure-cases/compile", async (request, reply) => {
    const parsed = compileFailureSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_COMPILE_REQUEST", issues: parsed.error.issues });
    const bundle = compileFailureToCase({
      runId: parsed.data.runId,
      taskId: parsed.data.taskId,
      caseId: parsed.data.caseId ?? null,
      title: parsed.data.title,
      goal: parsed.data.goal,
      ...(parsed.data.family ? { family: parsed.data.family } : {}),
      ...(parsed.data.difficulty ? { difficulty: parsed.data.difficulty } : {}),
      ...(parsed.data.timeoutMs ? { timeoutMs: parsed.data.timeoutMs } : {}),
      ...(parsed.data.inputs ? { inputs: parsed.data.inputs as never } : {}),
      ...(parsed.data.artifacts ? { artifacts: parsed.data.artifacts } : {}),
      ...(parsed.data.expectedOutputs ? { expectedOutputs: parsed.data.expectedOutputs } : {}),
      ...(parsed.data.primaryCause ? { primaryCause: parsed.data.primaryCause } : {}),
      ...(parsed.data.observed ? { observed: parsed.data.observed } : {})
    });
    store.saveRegressionCase({
      id: bundle.manifest.id,
      sourceRunId: bundle.provenance.sourceRunId,
      sourceTaskId: bundle.provenance.sourceTaskId,
      state: bundle.contract.state,
      payload: bundle as unknown as Record<string, unknown>
    });
    store.appendEvent("failure_case.compiled", { payload: { caseId: bundle.manifest.id, sourceRunId: parsed.data.runId } });
    return reply.send(bundle);
  });

  app.get("/api/evidence/failure-cases", async (_request, reply) => {
    return reply.send({ cases: store.listRegressionCases() });
  });

  app.get("/api/evidence/failure-cases/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = store.getRegressionCase(id);
    if (!found) return reply.code(404).send({ error: "REGRESSION_CASE_NOT_FOUND" });
    return reply.send(found);
  });

  app.post("/api/evidence/failure-cases/:id/advance", async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = store.getRegressionCase(id);
    if (!found) return reply.code(404).send({ error: "REGRESSION_CASE_NOT_FOUND" });
    const parsed = advanceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ADVANCE_REQUEST", issues: parsed.error.issues });
    const payload = found.payload as unknown as FailureCaseBundle;
    const contract = payload.contract;
    let event: Parameters<typeof advanceReproduction>[1];
    if (parsed.data.stage === "baseline" || parsed.data.stage === "patched") {
      if (!parsed.data.experimentId || !parsed.data.runId || !parsed.data.verdict) {
        return reply.code(400).send({ error: "EXPERIMENT_RUN_VERDICT_REQUIRED" });
      }
      event = {
        stage: parsed.data.stage,
        experimentId: parsed.data.experimentId,
        runId: parsed.data.runId,
        verdict: parsed.data.verdict
      };
    } else if (parsed.data.stage === "approve") {
      if (!parsed.data.reviewer) return reply.code(400).send({ error: "REVIEWER_REQUIRED" });
      event = { stage: "approve", reviewer: parsed.data.reviewer };
    } else {
      if (!parsed.data.reviewer) return reply.code(400).send({ error: "REVIEWER_REQUIRED" });
      event = { stage: "reject", reviewer: parsed.data.reviewer, reason: parsed.data.reason ?? "未说明原因" };
    }
    const next = advanceReproduction(contract as ReproductionContract, event);
    payload.contract = next;
    store.saveRegressionCase({
      id,
      sourceRunId: payload.provenance.sourceRunId,
      sourceTaskId: payload.provenance.sourceTaskId,
      state: next.state,
      payload: payload as unknown as Record<string, unknown>
    });
    store.appendEvent("failure_case.advanced", { payload: { caseId: id, state: next.state } });
    return reply.send(payload);
  });

  app.get("/api/evidence/experiments/:id/manifest", async (request, reply) => {
    const { id } = request.params as { id: string };
    const stored = store.getExperimentManifest(id);
    if (!stored) return reply.code(404).send({ error: "EXPERIMENT_MANIFEST_NOT_FOUND" });
    const parsed = parseExperimentManifest(stored);
    if (!parsed.ok) return reply.code(500).send({ error: "INVALID_EXPERIMENT_MANIFEST", errors: parsed.errors });
    return reply.send(parsed.manifest);
  });

  app.get("/api/evidence/experiments/compare", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (typeof query.left !== "string" || typeof query.right !== "string") {
      return reply.code(400).send({ error: "LEFT_RIGHT_REQUIRED" });
    }
    const left = store.getExperimentManifest(query.left) as unknown as ExperimentManifest | null;
    const right = store.getExperimentManifest(query.right) as unknown as ExperimentManifest | null;
    if (!left || !right) return reply.code(404).send({ error: "EXPERIMENT_MANIFEST_NOT_FOUND" });
    return reply.send(experimentDiff(left, right));
  });

  app.get("/api/evidence/experiments/:id/stats", async (request, reply) => {
    const { id } = request.params as { id: string };
    const experiment = store.getExperiment(id);
    if (!experiment) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND" });
    const runs = store.listRuns(id);
    const rows = runs.map((run) => {
      const metrics = store.getRunMetrics(run.id);
      return {
        status: run.status,
        caseId: run.caseKey,
        durationMs: run.startedAt && run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : null,
        costUsd: metrics?.costUsd ?? null,
        safetyBlocker: false,
        nondeterministic: false,
        manifestChanged: false
      };
    });
    const stats = regressionStatsFromRuns({ experimentId: id, runs: rows });
    return reply.send(stats);
  });

  app.post("/api/evidence/regression-gate", async (request, reply) => {
    const parsed = regressionGateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REGRESSION_GATE", issues: parsed.error.issues });
    const config = Object.fromEntries(
      Object.entries(parsed.data.config ?? {}).filter(([, value]) => value !== undefined)
    ) as Partial<typeof DEFAULT_REGRESSION_GATE>;
    const report = evaluateRegressionGate(parsed.data.baseline, parsed.data.candidate, {
      ...DEFAULT_REGRESSION_GATE,
      ...config
    });
    return reply.send(report);
  });

  app.get("/api/evidence/variants/compare", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (typeof query.left !== "string" || typeof query.right !== "string") {
      return reply.code(400).send({ error: "LEFT_RIGHT_REQUIRED" });
    }
    const left = store.getExperiment(query.left);
    const right = store.getExperiment(query.right);
    if (!left || !right) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND" });
    const comparison = compareVariants({
      leftVariantId: left.config.harnessVariantId ?? "baseline",
      rightVariantId: right.config.harnessVariantId ?? "baseline",
      leftRuns: store.listRuns(left.id).map((run) => ({
        caseKey: run.caseKey,
        repetition: run.repetition,
        passed: run.status === "passed",
        score: run.score,
        costUsd: store.getRunMetrics(run.id)?.costUsd ?? null,
        durationMs: run.startedAt && run.finishedAt
          ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
          : null
      })),
      rightRuns: store.listRuns(right.id).map((run) => ({
        caseKey: run.caseKey,
        repetition: run.repetition,
        passed: run.status === "passed",
        score: run.score,
        costUsd: store.getRunMetrics(run.id)?.costUsd ?? null,
        durationMs: run.startedAt && run.finishedAt
          ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))
          : null
      }))
    });
    return reply.send(comparison);
  });

  app.post("/api/evidence/stable-subset", async (request, reply) => {
    const body = request.body as {
      cases?: Array<Record<string, unknown>>;
      history?: Array<{ caseKey: string; passed: boolean }>;
      maxSubset?: number;
    } | null;
    if (!body || !Array.isArray(body.cases) || !Array.isArray(body.history)) {
      return reply.code(400).send({ error: "CASES_AND_HISTORY_REQUIRED" });
    }
    const subset = selectStableSubset(
      body.cases as never,
      body.history,
      body.maxSubset ? { maxSubset: body.maxSubset } : {}
    );
    return reply.send(subset);
  });

  app.get("/api/evidence/cases/:caseId/verification", async (request, reply) => {
    const { caseId } = request.params as { caseId: string };
    const loaded = catalog.get(caseId);
    if (!loaded) return reply.code(404).send({ error: "CASE_NOT_FOUND" });
    return reply.send({ spec: compileCaseVerification(loaded.manifest) satisfies VerificationSpec });
  });
}

export interface EvidenceRouteDeps {
  store: EvalStore;
  catalog: Map<string, LoadedCase>;
  repoRoot: string;
  artifactRoot: string;
  client: EvidenceClient;
}
