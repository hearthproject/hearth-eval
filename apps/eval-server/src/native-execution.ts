import type {
  EvalEventRecord,
  EvalTrace,
  ExperimentEnvironment,
  ExperimentRecord,
  ExperimentRunRecord,
  GraderResultRecord,
  HumanReviewRecord,
  MetricSummary
} from "@hearth/eval-core";
import type { LoadedCase } from "@hearth/eval-core/node";
import type { RunMetrics, EvalStore } from "./store.ts";
import type { EvalRunner } from "./runner.ts";
import type { NativeAgentClient } from "./native-client.ts";
import type { ProviderStore } from "./provider-store.ts";
import { markNativeEnvironment } from "./native-engine.ts";

export interface NativeRunInput {
  judgeModel?: string | null;
  store: EvalStore;
  client: NativeAgentClient;
  providers: ProviderStore;
  runner: EvalRunner;
  loaded: LoadedCase;
  providerId: string;
}

export interface NativeRunOutput {
  experiment: ExperimentRecord;
  run: ExperimentRunRecord;
  graders: GraderResultRecord[];
  trace: EvalTrace | null;
  events: EvalEventRecord[];
  review: HumanReviewRecord | null;
  metrics: MetricSummary[];
  usage: RunMetrics | null;
}

/**
 * One synchronous native run: create the task through the shared runner
 * (`createExperiment` + `start`, so runs land in the same tables the full
 * console uses), wait for the agent loop, then read grading and trace back.
 */
export async function runNativeCase(input: NativeRunInput): Promise<NativeRunOutput> {
  const { store, providers, runner, loaded, providerId } = input;
  if (!providers.get(providerId)) throw new Error(`模型配置不存在：${providerId}`);

  const environment = await runner.collectEnvironment(input.judgeModel ?? null);
  const experiment = runner.createExperiment({
    name: `${loaded.manifest.id} · 原生 ${loaded.manifest.title}`,
    caseIds: [loaded.manifest.id],
    executorIds: [providerId],
    repetitions: 1,
    runMode: "offline",
    autoJudge: true,
    autoRetry: false,
    maxConcurrency: 1
  }, markNativeEnvironment(environment));
  runner.start(experiment.id);

  const run = await waitForRun(store, experiment.id, loaded.manifest.timeoutMs + 120_000);
  const finishedExperiment = store.getExperiment(experiment.id) ?? experiment;
  return {
    experiment: finishedExperiment,
    run,
    graders: store.listGraderResults(run.id),
    trace: store.getTrace(run.id),
    events: store.listEvents({ runId: run.id, limit: 500 }),
    review: store.getHumanReview(run.id),
    metrics: runner.metricsForRun(run.id),
    usage: store.getRunMetrics(run.id)
  };
}

export function markNative(environment: ExperimentEnvironment): ExperimentEnvironment {
  return { ...environment, nativeEngine: "native" } as ExperimentEnvironment;
}

async function waitForRun(store: EvalStore, experimentId: string, timeoutMs: number): Promise<ExperimentRunRecord> {
  const deadline = Date.now() + timeoutMs;
  const terminal = ["passed", "failed", "blocked", "cancelled", "error", "needs_review"];
  while (Date.now() < deadline) {
    const runs = store.listRuns(experimentId);
    const run = runs[0];
    if (run && terminal.includes(run.status)) return run;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 200));
  }
  const fallback = store.listRuns(experimentId)[0];
  if (!fallback) throw new Error("评测运行未创建");
  return fallback;
}
