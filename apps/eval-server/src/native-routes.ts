import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  EVAL_FAMILIES,
  type CaseVersionSummary,
  type EvalFamily,
  type ExperimentDetailResponse,
  type ExperimentRecord,
  type ExperimentsResponse,
  type RunDetailResponse
} from "@hearth/eval-core";
import type { LoadedCase } from "@hearth/eval-core/node";
import type { EvalRunner } from "./runner.ts";
import type { EvalStore } from "./store.ts";
import type { NativeAgentClient } from "./native-client.ts";
import type { ProviderStore } from "./provider-store.ts";
import { ProviderError } from "./providers.ts";
import { runNativeCase } from "./native-execution.ts";
import { isNative } from "./native-engine.ts";

const nativeRunSchema = z.object({
  caseId: z.string().trim().min(1).max(100),
  providerId: z.string().trim().min(1).max(80)
}).strict();

const submitReviewSchema = z.object({
  decision: z.enum(["pass", "fail", "unknown"]),
  reviewer: z.string().trim().max(80).optional(),
  note: z.string().max(4_000).optional()
}).strict();

export interface NativeRoutesOptions {
  store: EvalStore;
  runner: EvalRunner;
  client: NativeAgentClient;
  providers: ProviderStore;
  catalog: Map<string, LoadedCase>;
  artifactRoot: string;
}

/**
 * The native console: small, Hearth-free endpoints used by
 * `apps/eval-web/native/`. It reuses the same store, runner and adapter
 * boundary as the full console.
 */
export function registerNativeRoutes(app: FastifyInstance, options: NativeRoutesOptions): void {
  const { store, runner, client, providers, catalog, artifactRoot } = options;

  app.get("/api/native/system", async () => {
    const list = providers.list();
    return {
      engine: "native",
      version: "0.1.0-native",
      time: new Date().toISOString(),
      providers: list.map((provider) => ({ ...provider, runnable: provider.apiKeyHint !== null })),
      executors: client.executorOptions().map((provider) => ({
        id: provider.id,
        name: provider.name,
        description: `${provider.model} · ${provider.kind}`,
        capabilities: ["llm", "files"],
        canRun: provider.apiKeyHint !== null && catalog.size > 0,
        version: null,
        issues: provider.apiKeyHint === null ? ["缺少 API Key"] : []
      })),
      catalogCases: catalog.size,
      artifactRoot
    };
  });

  app.get("/api/native/cases", async () => {
    const counts = Object.fromEntries(EVAL_FAMILIES.map((family) => [family, 0])) as Record<EvalFamily, number>;
    const cases = [...catalog.values()].map((loaded) => {
      const summary = store.getCase(loaded.manifest.id)?.summary ?? summaryOf(loaded);
      counts[summary.family] += 1;
      return {
        ...summary,
        hasJudge: loaded.manifest.criteria.some((criterion) => criterion.source === "judge"),
        inputKinds: [...new Set(loaded.manifest.inputs.map((input) => input.kind))]
      };
    });
    return { cases, counts, generatedAt: new Date().toISOString() };
  });

  app.get<{ Params: { caseKey: string } }>("/api/native/cases/:caseKey", async (request, reply) => {
    const stored = store.getCase(request.params.caseKey);
    if (!stored) return reply.code(404).send({ error: "CASE_NOT_FOUND", message: "case 不存在" });
    return { case: stored.summary, manifest: stored.manifest };
  });

  /** Synchronous single run: resolves once the agent loop finished and was graded. */
  app.post("/api/native/run", async (request, reply) => {
    const parsed = nativeRunSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_RUN", message: "运行参数不正确", issues: parsed.error.issues });
    }
    const loaded = catalog.get(parsed.data.caseId);
    if (!loaded) return reply.code(404).send({ error: "CASE_NOT_FOUND", message: `case 不存在：${parsed.data.caseId}` });
    if (!providers.get(parsed.data.providerId)) {
      return reply.code(400).send({ error: "PROVIDER_NOT_FOUND", message: `模型配置不存在：${parsed.data.providerId}` });
    }
    try {
      return await runNativeCase({
        store,
        client,
        providers,
        runner,
        loaded,
        providerId: parsed.data.providerId
      });
    } catch (error) {
      return sendNativeError(reply, error);
    }
  });

  app.get("/api/native/runs", async (): Promise<ExperimentsResponse> => {
    return { experiments: store.listExperiments(50).filter((experiment) => isNative(experiment)) };
  });

  app.get<{ Params: { id: string } }>("/api/native/experiments/:id", async (request, reply): Promise<ExperimentDetailResponse | FastifyReply> => {
    const experiment = store.getExperiment(request.params.id);
    if (!experiment) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND", message: "实验不存在" });
    return {
      experiment,
      runs: store.listRuns(experiment.id),
      summary: experiment.summary ?? runner.summarize(experiment.id),
      events: store.listEvents({ experimentId: experiment.id, limit: 500 })
    };
  });

  app.get<{ Params: { id: string } }>("/api/native/runs/:id", async (request, reply): Promise<RunDetailResponse | FastifyReply> => {
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: "评测运行不存在" });
    const stored = store.getCase(run.caseKey);
    const task = run.hearthTaskId ? client.getNativeTask(run.hearthTaskId) : null;
    return {
      run,
      case: stored?.summary ?? null,
      manifest: stored?.manifest ?? null,
      graders: store.listGraderResults(run.id),
      review: store.getHumanReview(run.id),
      events: store.listEvents({ runId: run.id, limit: 500 }),
      artifacts: [],
      trace: store.getTrace(run.id),
      metrics: runner.metricsForRun(run.id),
      hearthTask: task ? { id: task.id, status: task.status, error: task.error, usage: task.usage, turns: task.turns } : null
    };
  });

  app.post<{ Params: { id: string } }>("/api/native/runs/:id/review", async (request, reply) => {
    const parsed = submitReviewSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REVIEW", message: "复核参数不正确", issues: parsed.error.issues });
    }
    try {
      const review = runner.review(request.params.id, parsed.data.decision, parsed.data.reviewer, parsed.data.note);
      return { review, run: store.getRun(request.params.id) };
    } catch (error) {
      return sendNativeError(reply, error);
    }
  });

  void artifactRoot;
}

function summaryOf(loaded: LoadedCase): CaseVersionSummary {
  return {
    caseKey: loaded.manifest.id,
    version: loaded.manifest.version,
    schemaVersion: loaded.manifest.schemaVersion,
    lifecycle: loaded.manifest.lifecycle ?? "active",
    title: loaded.manifest.title,
    family: loaded.manifest.family,
    difficulty: loaded.manifest.difficulty,
    runModes: loaded.manifest.runModes,
    contentHash: loaded.contentHash
  };
}

export function isNativeExperiment(experiment: ExperimentRecord): boolean {
  return isNative(experiment);
}

function sendNativeError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProviderError) {
    return reply.code(error.code === "PROVIDER_NOT_FOUND" ? 404 : 400).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({ error: "NATIVE_ERROR", message: error instanceof Error ? error.message : String(error) });
}
