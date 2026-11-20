import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type {
  CaseCatalogResponse,
  CaseDetailResponse,
  CaseVersionSummary,
  CompareResponse,
  CreateExperimentRequest,
  DashboardResponse,
  EvalFamily,
  EvalExecutorOption,
  EvalSystemResponse,
  ExperimentComparison,
  ExperimentDetailResponse,
  ExperimentRunRecord,
  ExperimentsResponse,
  ReviewQueueItem,
  ReviewsResponse,
  RunArtifactView,
  RunDetailResponse,
  RegressionReport,
  SubmitReviewRequest
} from "@hearth/eval-core";
import { EVAL_FAMILIES } from "@hearth/eval-core";
import type { LoadedCase } from "@hearth/eval-core/node";
import type { FastifyInstance, FastifyReply } from "fastify";
import Fastify from "fastify";
import { z } from "zod";
import { EvalRunnerError, type EvalRunner } from "./runner.ts";
import type { EvalStore, StoredCase } from "./store.ts";
import type { HearthClient } from "./hearth-client.ts";
import type { AgentAdapter } from "./agent-adapter.ts";
import { resolveRunOutputDir } from "./artifact-path.ts";
import { listScenarioBatches, readScenarioBatch, readScenarioEvidence } from "./scenario-reports.ts";
import { ScenarioSelfCheckService } from "./scenario-self-check.ts";
import { registerImportedEvaluationRoutes } from "./imported-evaluation.ts";
import { DiagnosisAgent } from "./diagnosis-agent.ts";
import { CodexDiagnosisModel, type DiagnosisModel } from "./diagnosis-model.ts";
import { registerDiagnosisRoutes } from "./diagnosis-routes.ts";
import type { NativeAgentClient } from "./native-client.ts";
import type { ProviderStore } from "./provider-store.ts";
import { registerNativeRoutes } from "./native-routes.ts";
import { registerProviderRoutes } from "./provider-routes.ts";
import { registerSystemSettingsRoutes } from "./system-settings-routes.ts";
import { LocalJudge } from "./local-judge.ts";
import { ProviderStore as JudgeProviderStore } from "./provider-store.ts";
import { AcceptanceAgent, desktopDirectory } from "./acceptance-agent.ts";
import { HearthAcceptanceExecutor } from "./acceptance-executor.ts";
import { registerAcceptanceRoutes } from "./acceptance-routes.ts";

const createExperimentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  caseIds: z.array(z.string().trim().min(1).max(100)).min(1).max(200),
  executorIds: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  repetitions: z.number().int().min(1).max(5).default(1),
  runMode: z.enum(["offline", "live"]).default("offline"),
  autoJudge: z.boolean().default(true),
  autoRetry: z.boolean().default(true),
  maxConcurrency: z.number().int().min(1).max(8).default(1),
  baselineExperimentId: z.string().trim().min(1).max(100).nullable().optional()
}).strict();

const submitReviewSchema = z.object({
  decision: z.enum(["pass", "fail", "unknown"]),
  reviewer: z.string().trim().max(80).optional(),
  note: z.string().max(4_000).optional()
}).strict();

const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1_000).default(300),
  experimentId: z.string().trim().min(1).max(100).optional(),
  runId: z.string().trim().min(1).max(100).optional()
}).strict();

export interface EvalAppOptions {
  localJudge?: LocalJudge;
  diagnosisModel?: DiagnosisModel;
  store: EvalStore;
  runner: EvalRunner;
  client: HearthClient | AgentAdapter;
  /** Native engine extras; when present, native console and provider routes are registered. */
  providers?: ProviderStore;
  nativeClient?: NativeAgentClient;
  catalog: Map<string, LoadedCase>;
  catalogIssues: number;
  repoRoot: string;
  artifactRoot: string;
  dataDir: string;
  evalVersion: string;
  webDist?: string;
  logger?: boolean;
}

interface JudgeInfo {
  configured: boolean;
  model: string | null;
}

export async function buildEvalApp(options: EvalAppOptions): Promise<FastifyInstance> {
  const { store, runner, client, catalog, repoRoot, artifactRoot } = options;
  const localJudge = options.localJudge ?? new LocalJudge(new JudgeProviderStore({ file: join(repoRoot, ".hearth", "judge-providers.json") }));
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_000_000 });
  const acceptance = new AcceptanceAgent({ store, executor: new HearthAcceptanceExecutor(client.baseUrl), desktopRoot: desktopDirectory, judge: localJudge });
  await registerAcceptanceRoutes(app, acceptance, client.baseUrl);
  app.addHook("onClose", async () => acceptance.close());
  registerImportedEvaluationRoutes(app, store);
  const diagnosis = new DiagnosisAgent({ store, runner, model: options.diagnosisModel ?? new CodexDiagnosisModel(),
    health: () => client.health(), repoRoot, artifactRoot });
  registerDiagnosisRoutes(app, diagnosis, store);
  app.addHook("onClose", async () => diagnosis.close());
  if (options.providers && options.nativeClient) {
    registerProviderRoutes(app, options.providers);
    registerNativeRoutes(app, {
      store,
      runner,
      client: options.nativeClient,
      providers: options.providers,
      judgeModel: async () => (await localJudge.modelSettings()).settings.model || null,
      catalog,
      artifactRoot
    });
  }
  app.get("/api/codex/setup", async () => {
    const directory = join(repoRoot, "integrations", "codex");
    const hook = JSON.parse(readFileSync(join(directory, "hooks.json"), "utf8")) as {
      hooks: { Stop: [{ hooks: [{ command: string }] }] };
    };
    const script = join(directory, "stop.mjs");
    const handler = hook.hooks.Stop[0].hooks[0];
    handler.command = process.platform === "win32"
      ? `node "${script.replace(/\\/g, "/")}"`
      : `node '${script.replace(/'/g, "'\\''")}'`;
    const rules = JSON.parse(readFileSync(join(directory, "codex-eval.example.json"), "utf8")) as {
      requiredText: string[];
      port?: number;
    };
    const address = app.server.address();
    if (address && typeof address !== "string" && address.port !== 4318) rules.port = address.port;
    return { hook: JSON.stringify(hook, null, 2), rules: JSON.stringify(rules, null, 2) };
  });
  const scenarioRoot = join(repoRoot, "eval", "scenario-runs");
  const selfCheck = new ScenarioSelfCheckService(repoRoot);
  app.addHook("onClose", async () => selfCheck.close());
  app.get("/api/scenarios/self-check", async () => selfCheck.snapshot());
  app.get("/api/scenarios/catalog", async () => selfCheck.scenarios());
  app.post("/api/scenarios/self-check", async (request, reply) => {
    const parsed = z.object({ scenarioId: z.string().regex(/^[a-z0-9_-]+$/).optional() }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ message: "场景参数不正确" });
    if (selfCheck.snapshot().status === "running") return reply.code(409).send({ message: "已有场景自检正在运行" });
    try { return reply.code(202).send(await selfCheck.start(parsed.data.scenarioId)); }
    catch (error) { return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/scenarios", async () => {
    const historical = await listScenarioBatches(scenarioRoot);
    const latest = selfCheck.batch();
    if (!latest) return historical;
    const { runs, ...summary } = latest;
    return [summary, ...historical];
  });
  app.get<{ Params: { id: string } }>("/api/scenarios/:id", async (request, reply) => {
    const latest = selfCheck.batch();
    const batch = latest?.id === request.params.id ? latest : await readScenarioBatch(scenarioRoot, request.params.id);
    return batch ?? reply.code(404).send({ error: "SCENARIO_BATCH_NOT_FOUND", message: "找不到场景运行报告" });
  });
  app.get<{ Params: { id: string; scenarioId: string; repetition: string } }>(
    "/api/scenarios/:id/:scenarioId/:repetition/evidence",
    async (request, reply) => {
      const { id, scenarioId, repetition } = request.params;
      const evidence = selfCheck.evidence(id, scenarioId, repetition) ?? await readScenarioEvidence(scenarioRoot, id, scenarioId, repetition);
      return evidence ?? reply.code(404).send({ error: "SCENARIO_EVIDENCE_NOT_FOUND", message: "找不到场景证据" });
    }
  );
  await registerSystemSettingsRoutes(app, { repoRoot, current: { dataDir: options.dataDir, artifactRoot },
    modelClient: localJudge });

  const judgeInfo = async (): Promise<JudgeInfo> => {
    const settings = await localJudge.modelSettings();
    return { configured: settings.configured, model: settings.settings.model || null };
  };

  const systemInfo = async (): Promise<EvalSystemResponse> => {
    const judge = await judgeInfo();
    let reachable = false;
    let hearthStatus = "offline";
    let executors: EvalExecutorOption[] = [];
    try {
      const health = await client.health();
      reachable = true;
      hearthStatus = typeof health.status === "string" ? health.status : "online";
    } catch {
      reachable = false;
    }
    try { executors = client.executors ? executorOptions(await client.executors()) : []; } catch { executors = []; }
    return {
      evalVersion: options.evalVersion,
      hearthUrl: client.baseUrl,
      hearthReachable: reachable,
      hearthStatus,
      judgeConfigured: judge.configured,
      judgeModel: judge.model,
      executors,
      catalogCases: catalog.size,
      catalogIssues: options.catalogIssues,
      artifactRoot,
      dataDir: options.dataDir,
      runningExperiments: store.countRunningExperiments(),
      pendingReviews: store.countPendingReviews(),
      generatedAt: new Date().toISOString()
    };
  };

  app.get("/api/health", async () => ({
    ok: true,
    service: "hearth-eval",
    version: options.evalVersion,
    cases: catalog.size,
    time: new Date().toISOString()
  }));

  app.get("/api/system", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return systemInfo();
  });

  app.get("/api/dashboard", async (_request, reply): Promise<DashboardResponse> => {
    reply.header("cache-control", "no-store");
    const experiments = store.listExperiments(5);
    return {
      catalog: catalogResponse(store.listCases()),
      recentExperiments: experiments,
      latestSummary: experiments[0]?.summary ?? null,
      pendingReviews: store.countPendingReviews(),
      runningExperiments: store.countRunningExperiments(),
      system: await systemInfo()
    };
  });

  app.get<{ Querystring: { family?: string; difficulty?: string; runMode?: string; search?: string } }>("/api/cases", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const family = request.query.family;
    const difficulty = request.query.difficulty;
    const runMode = request.query.runMode;
    const search = request.query.search?.trim().toLowerCase();
    const cases = store.listCases().filter((item) => {
      if (family && item.summary.family !== family) return false;
      if (difficulty && item.summary.difficulty !== difficulty) return false;
      if (runMode && !item.summary.runModes.includes(runMode as CaseVersionSummary["runModes"][number])) return false;
      if (search) {
        const haystack = [item.summary.caseKey, item.summary.title, ...item.manifest.tags].join(" ").toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
    return { ...catalogResponse(cases), cases: cases.map((item) => item.summary) };
  });

  app.get<{ Params: { caseKey: string } }>("/api/cases/:caseKey", async (request, reply): Promise<CaseDetailResponse | FastifyReply> => {
    const stored = store.getCase(request.params.caseKey);
    if (!stored) return reply.code(404).send({ error: "CASE_NOT_FOUND", message: "case 不存在" });
    return {
      case: stored.summary,
      manifest: stored.manifest,
      hasGolden: existsSync(join(repoRoot, "eval", "cases", stored.summary.caseKey, "golden"))
    };
  });

  app.get("/api/experiments", async (_request, reply): Promise<ExperimentsResponse> => {
    reply.header("cache-control", "no-store");
    return { experiments: store.listExperiments(200) };
  });

  app.post("/api/experiments", async (request, reply) => {
    const parsed = createExperimentSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_EXPERIMENT", message: "实验参数不正确", issues: parsed.error.issues });
    }
    try {
      const judge = await judgeInfo();
      const environment = await runner.collectEnvironment(judge.model);
      const experiment = runner.createExperiment(parsed.data as CreateExperimentRequest, environment);
      runner.start(experiment.id);
      return reply.code(201).send(experiment);
    } catch (error) {
      return sendRunnerError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/experiments/:id", async (request, reply): Promise<ExperimentDetailResponse | FastifyReply> => {
    reply.header("cache-control", "no-store");
    const experiment = store.getExperiment(request.params.id);
    if (!experiment) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND", message: "实验不存在" });
    return {
      experiment,
      runs: store.listRuns(experiment.id),
      summary: ["queued", "running", "grading"].includes(experiment.status)
        ? runner.summarize(experiment.id) : experiment.summary ?? runner.summarize(experiment.id),
      events: store.listEvents({ experimentId: experiment.id, limit: 500 })
    };
  });

  app.post<{ Params: { id: string } }>("/api/experiments/:id/cancel", async (request, reply) => {
    try {
      return runner.cancel(request.params.id);
    } catch (error) {
      return sendRunnerError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { includeTask?: string } }>("/api/runs/:id", async (request, reply): Promise<RunDetailResponse | FastifyReply> => {
    reply.header("cache-control", "no-store");
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: "评测运行不存在" });
    const storedCase = store.getCase(run.caseKey);
    let hearthTask: Record<string, unknown> | null = null;
    if (run.hearthTaskId && request.query.includeTask !== "false") {
      try {
        hearthTask = asRecord(await client.getTask(run.hearthTaskId));
      } catch (error) {
        hearthTask = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return {
      run,
      case: storedCase?.summary ?? null,
      manifest: storedCase?.manifest ?? null,
      graders: store.listGraderResults(run.id),
      review: store.getHumanReview(run.id),
      events: store.listEvents({ runId: run.id, limit: 500 }),
      artifacts: listRunArtifacts(repoRoot, artifactRoot, run.outputDir),
      trace: store.getTrace(run.id),
      metrics: runner.metricsForRun(run.id),
      hearthTask
    };
  });

  // Keep potentially slow Hearth reads separate from local run progress and grading.
  app.get<{ Params: { id: string } }>("/api/runs/:id/task", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: "评测运行不存在" });
    if (!run.hearthTaskId) return null;
    try {
      return await client.getTask(run.hearthTaskId);
    } catch (error) {
      return reply.code(502).send({ error: "TASK_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/reviews", async (_request, reply): Promise<ReviewsResponse> => {
    reply.header("cache-control", "no-store");
    const reviews = store.listPendingReviewRuns().map((run): ReviewQueueItem => {
      const storedCase = store.getCase(run.caseKey);
      const experiment = store.getExperiment(run.experimentId);
      const score = run.score === null ? "未评分" : `${run.score.toFixed(1)} 分`;
      const detail = run.error ?? (run.reviewReasons.length > 0 ? run.reviewReasons.join(", ") : "等待人工确认");
      return {
        run,
        case: storedCase?.summary ?? null,
        experimentName: experiment?.name ?? run.experimentId,
        reasons: run.reviewReasons,
        summary: `${score} · ${detail}`
      };
    });
    return { reviews };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/review", async (request, reply) => {
    const parsed = submitReviewSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REVIEW", message: "复核参数不正确", issues: parsed.error.issues });
    }
    try {
      const review = runner.review(request.params.id, parsed.data.decision, parsed.data.reviewer, parsed.data.note);
      const run = store.getRun(request.params.id);
      return { review, run, experiment: run ? store.getExperiment(run.experimentId) : null };
    } catch (error) {
      return sendRunnerError(reply, error);
    }
  });

  app.get<{ Querystring: { left?: string; right?: string } }>("/api/compare", async (request, reply): Promise<CompareResponse | FastifyReply> => {
    const leftId = request.query.left?.trim();
    const rightId = request.query.right?.trim();
    if (!leftId || !rightId) {
      return reply.code(400).send({ error: "COMPARE_REQUIRES_TWO", message: "比较需要 left 与 right 两个实验 ID" });
    }
    const left = store.getExperiment(leftId);
    const right = store.getExperiment(rightId);
    if (!left || !right) {
      return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND", message: `实验不存在：${!left ? leftId : rightId}` });
    }
    const leftSummary = left.summary ?? runner.summarize(left.id);
    const rightSummary = right.summary ?? runner.summarize(right.id);
    const warnings: string[] = [];
    if (!leftSummary || !rightSummary) warnings.push("至少一侧实验还没有可用的汇总结果。");
    if (left.config.runMode !== right.config.runMode) warnings.push("两侧运行模式不同。");
    if (left.config.repetitions !== right.config.repetitions) warnings.push("两侧重复次数不同。");
    if (!sameStrings(left.config.executorIds, right.config.executorIds)) warnings.push("两侧执行器集合不同。");
    if (!sameStrings(left.config.caseIds, right.config.caseIds)) warnings.push("两侧 case 集合不同。");
    const environmentDifferences: CompareResponse["environmentDifferences"] = [];
    const environmentChecks: Array<[string, string | number | null, string | number | null]> = [
      ["Judge 模型", left.environment.judgeModel, right.environment.judgeModel],
      ["Hearth 实例", left.environment.instanceId, right.environment.instanceId],
      ["Hearth 地址", left.environment.hearthUrl, right.environment.hearthUrl],
      ["Hearth Schema", left.environment.schemaVersion, right.environment.schemaVersion],
      ["评测版本", left.environment.evalVersion, right.environment.evalVersion]
    ];
    for (const [label, leftValue, rightValue] of environmentChecks) {
      if (leftValue === rightValue) continue;
      environmentDifferences.push({ label, left: leftValue, right: rightValue });
      warnings.push(`${label}不同：${leftValue ?? "无"} → ${rightValue ?? "无"}。`);
    }
    const leftByCase = groupRunsByCase(store.listRuns(left.id));
    const rightByCase = groupRunsByCase(store.listRuns(right.id));
    const caseKeys = [...new Set([...leftByCase.keys(), ...rightByCase.keys()])].sort();
    const caseVersionMismatches: string[] = [];
    const caseDeltas = caseKeys.map((caseKey) => {
      const leftStats = caseStats(leftByCase.get(caseKey) ?? []);
      const rightStats = caseStats(rightByCase.get(caseKey) ?? []);
      const versionMismatch = leftStats.runs > 0 && rightStats.runs > 0
        && !sameNumbers(leftStats.versions, rightStats.versions);
      if (versionMismatch) {
        caseVersionMismatches.push(caseKey);
        warnings.push(`${caseKey} 的 case 版本不同：A ${leftStats.versions.join("/")} · B ${rightStats.versions.join("/")}`);
      }
      return {
        caseKey,
        leftVersions: leftStats.versions,
        rightVersions: rightStats.versions,
        leftRuns: leftStats.runs,
        rightRuns: rightStats.runs,
        leftPassRate: leftStats.passRate,
        rightPassRate: rightStats.passRate,
        passRateDelta: leftStats.passRate === null || rightStats.passRate === null ? null : round2(rightStats.passRate - leftStats.passRate),
        leftAvgScore: leftStats.avgScore,
        rightAvgScore: rightStats.avgScore,
        scoreDelta: leftStats.avgScore === null || rightStats.avgScore === null ? null : round2(rightStats.avgScore - leftStats.avgScore),
        versionMismatch
      };
    });
    const familyDeltas = EVAL_FAMILIES.map((family) => {
      const leftPassRate = leftSummary?.families.find((item) => item.family === family)?.passRate ?? null;
      const rightPassRate = rightSummary?.families.find((item) => item.family === family)?.passRate ?? null;
      return {
        family,
        leftPassRate,
        rightPassRate,
        delta: leftPassRate === null || rightPassRate === null ? null : Math.round((rightPassRate - leftPassRate) * 100) / 100
      };
    });
    return {
      leftExperimentId: left.id,
      rightExperimentId: right.id,
      leftName: left.name,
      rightName: right.name,
      aligned: warnings.length === 0,
      warnings,
      left: leftSummary,
      right: rightSummary,
      caseDeltas,
      caseVersionMismatches,
      environmentDifferences,
      familyDeltas
    };
  });

  app.get<{ Params: { id: string } }>("/api/experiments/:id/regression", async (request, reply): Promise<RegressionReport | FastifyReply> => {
    const experiment = store.getExperiment(request.params.id);
    if (!experiment) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND", message: "实验不存在" });
    const baselineExperimentId = experiment.config.baselineExperimentId;
    if (!baselineExperimentId) {
      return reply.code(400).send({ error: "BASELINE_REQUIRED", message: "该实验未指定基线，无法执行回归门禁" });
    }
    try {
      return runner.regressionReport(experiment.id, baselineExperimentId);
    } catch (error) {
      return sendRunnerError(reply, error);
    }
  });

  app.get<{ Querystring: { after?: string; limit?: string; experimentId?: string; runId?: string } }>("/api/events", async (request, reply) => {
    const parsed = eventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_EVENTS_QUERY", message: "事件查询参数不正确", issues: parsed.error.issues });
    }
    reply.header("cache-control", "no-store");
    return {
      events: store.listEvents({
        afterSeq: parsed.data.after,
        limit: parsed.data.limit,
        ...(parsed.data.experimentId ? { experimentId: parsed.data.experimentId } : {}),
        ...(parsed.data.runId ? { runId: parsed.data.runId } : {})
      })
    };
  });

  app.get<{ Params: { id: string; "*": string } }>("/api/runs/:id/artifacts/*", async (request, reply): Promise<RunArtifactView | FastifyReply> => {
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: "评测运行不存在" });
    const root = resolveRunOutputDir(repoRoot, artifactRoot, run.outputDir);
    const relative = decodeURIComponent(request.params["*"] ?? "");
    if (!relative) return reply.code(400).send({ error: "ARTIFACT_PATH_REQUIRED", message: "缺少产物路径" });
    const candidate = resolve(root, relative);
    if (!isPathInside(root, candidate) || !isPathInside(artifactRoot, candidate)) {
      return reply.code(403).send({ error: "ARTIFACT_PATH_DENIED", message: "不允许访问该产物路径" });
    }
    if (!existsSync(candidate)) return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND", message: "产物不存在" });
    const stats = statSync(candidate);
    if (!stats.isFile()) return reply.code(400).send({ error: "ARTIFACT_NOT_FILE", message: "目标不是文件" });
    const mimeType = mimeFor(candidate);
    const preview = isTextMime(mimeType) && stats.size <= 1_000_000
      ? readFileSync(candidate, "utf8")
      : null;
    return {
      path: relative.replace(/\\/g, "/"),
      bytes: stats.size,
      mimeType,
      preview
    };
  });

  if (options.webDist && existsSync(join(options.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: options.webDist, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/") && options.webDist && existsSync(join(options.webDist, "index.html"))) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "NOT_FOUND", message: `未找到：${request.url}` });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof EvalRunnerError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    app.log.error({ err: error, method: request.method, url: request.url }, "eval request failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) });
  });

  return app;
}

function catalogResponse(cases: StoredCase[]): CaseCatalogResponse {
  const counts = Object.fromEntries(EVAL_FAMILIES.map((family) => [family, 0])) as Record<EvalFamily, number>;
  for (const stored of cases) counts[stored.summary.family] += 1;
  return {
    cases: cases.map((stored) => stored.summary),
    counts,
    generatedAt: new Date().toISOString()
  };
}

function sendRunnerError(reply: FastifyReply, error: unknown) {
  if (error instanceof EvalRunnerError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({
    error: "EVAL_INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error)
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function groupRunsByCase(runs: ExperimentRunRecord[]): Map<string, ExperimentRunRecord[]> {
  const grouped = new Map<string, ExperimentRunRecord[]>();
  for (const run of runs) grouped.set(run.caseKey, [...(grouped.get(run.caseKey) ?? []), run]);
  return grouped;
}

function caseStats(runs: ExperimentRunRecord[]): { runs: number; versions: number[]; passRate: number | null; avgScore: number | null } {
  const versions = [...new Set(runs.map((run) => run.caseVersion))].sort((left, right) => left - right);
  const scores = runs.flatMap((run) => run.score === null ? [] : [run.score]);
  return {
    runs: runs.length,
    versions,
    passRate: runs.length === 0 ? null : round2(runs.filter((run) => run.status === "passed").length / runs.length * 100),
    avgScore: scores.length === 0 ? null : round2(scores.reduce((sum, score) => sum + score, 0) / scores.length)
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function executorOptions(payload: Record<string, unknown>): EvalExecutorOption[] {
  if (!Array.isArray(payload.executors)) return [];
  return payload.executors.flatMap((value): EvalExecutorOption[] => {
    const record = asRecord(value);
    const health = asRecord(record?.health);
    if (!record || typeof record.id !== "string" || typeof record.name !== "string") return [];
    return [{
      id: record.id,
      name: record.name,
      description: typeof record.description === "string" ? record.description : "",
      capabilities: Array.isArray(record.capabilities)
        ? record.capabilities.filter((item): item is string => typeof item === "string")
        : [],
      canRun: health?.canRun === true,
      version: typeof health?.version === "string" ? health.version : null,
      issues: Array.isArray(health?.issues)
        ? health.issues.filter((item): item is string => typeof item === "string")
        : []
    }];
  });
}

function listRunArtifacts(repoRoot: string, artifactRoot: string, outputDir: string): RunArtifactView[] {
  const root = resolveRunOutputDir(repoRoot, artifactRoot, outputDir);
  if (!isPathInside(artifactRoot, root) || !existsSync(root)) return [];
  const artifacts: RunArtifactView[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 12 || artifacts.length >= 500) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || artifacts.length >= 500) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = statSync(absolute);
      if (stats.size > 20 * 1024 * 1024) continue;
      const mimeType = mimeFor(absolute);
      artifacts.push({
        path: absolute.slice(root.length + 1).replace(/\\/g, "/"),
        bytes: stats.size,
        mimeType,
        preview: isTextMime(mimeType) && stats.size <= 1_000_000 ? readFileSync(absolute, "utf8") : null
      });
    }
  };
  visit(root, 0);
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function mimeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if ([".md", ".markdown"].includes(extension)) return "text/markdown";
  if (extension === ".json") return "application/json";
  if ([".html", ".htm"].includes(extension)) return "text/html";
  if (extension === ".csv") return "text/csv";
  if ([".txt", ".log", ".yaml", ".yml", ".js", ".ts", ".css"].includes(extension)) return "text/plain";
  return "application/octet-stream";
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || mimeType === "application/json";
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, "");
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}
