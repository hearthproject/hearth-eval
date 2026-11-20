import { join } from "node:path";
import { loadCaseCatalog } from "@hearth/eval-core/node";
import { buildEvalApp } from "./app.ts";
import {
  ARTIFACT_ROOT,
  CASES_DIR,
  DATA_DIR,
  DB_PATH,
  EVAL_VERSION,
  HEARTH_URL,
  HEARTH_TIMEOUT_MS,
  HOST,
  PORT,
  RECOVERY_STALE_MS,
  REPO_ROOT,
  WEB_DIST
} from "./config.ts";
import { HearthClient } from "./hearth-client.ts";
import { LocalJudge } from "./local-judge.ts";
import { EvalRunner } from "./runner.ts";
import { EvalStore } from "./store.ts";
import { NativeAgentClient } from "./native-client.ts";
import { ProviderStore } from "./provider-store.ts";
import { CompositeAgentAdapter } from "./composite-adapter.ts";

async function main(): Promise<void> {
  const loaded = loadCaseCatalog(REPO_ROOT, CASES_DIR);
  if (loaded.issues.length > 0) {
    for (const issue of loaded.issues) {
      console.error(`[eval] catalog ${issue.caseId || "catalog"}: ${issue.path}: ${issue.message}`);
    }
    throw new Error(`Case catalog validation failed with ${loaded.issues.length} issue(s)`);
  }
  if (loaded.cases.length === 0) throw new Error(`No evaluation cases found in ${CASES_DIR}`);

  const store = new EvalStore(DB_PATH);
  store.syncCases(loaded.cases);
  const recovered = store.recoverInterrupted({ staleAfterMs: RECOVERY_STALE_MS });

  const catalog = new Map(loaded.cases.map((loadedCase) => [loadedCase.manifest.id, loadedCase]));

  // Native engine: user-supplied LLM API keys + the in-repo agent loop.
  const providers = new ProviderStore({ file: join(DATA_DIR, "providers.json") });
  const localJudge = new LocalJudge(new ProviderStore({ file: join(REPO_ROOT, ".hearth", "judge-providers.json") }));
  const nativeClient = new NativeAgentClient({ repoRoot: REPO_ROOT, artifactRoot: ARTIFACT_ROOT, providers });

  const hearthClient = new HearthClient({
    baseUrl: HEARTH_URL,
    timeoutMs: HEARTH_TIMEOUT_MS,
    artifactStorage: { repoRoot: REPO_ROOT, artifactRoot: ARTIFACT_ROOT }
  });
  // Hearth stays the default engine; provider-backed executors are routed to the native loop.
  const client = new CompositeAgentAdapter({ primary: hearthClient, native: nativeClient });

  const runner = new EvalRunner({
    store,
    client,
    judge: localJudge,
    catalog,
    repoRoot: REPO_ROOT,
    evalVersion: EVAL_VERSION,
    recoveryStaleMs: RECOVERY_STALE_MS,
    artifactRoot: ARTIFACT_ROOT
  });

  const app = await buildEvalApp({
    localJudge,
    store,
    runner,
    client,
    providers,
    nativeClient,
    catalog,
    catalogIssues: loaded.issues.length,
    repoRoot: REPO_ROOT,
    artifactRoot: ARTIFACT_ROOT,
    dataDir: DATA_DIR,
    evalVersion: EVAL_VERSION,
    webDist: WEB_DIST,
    logger: true
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down hearth eval");
    await nativeClient.idle().catch(() => undefined);
    await app.close();
    store.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: HOST, port: PORT });
  void runner.resumeInterruptedRuns().catch((error) => {
    app.log.error({ error }, "failed to resume interrupted eval runs");
  });
  app.log.info({
    url: `http://${HOST}:${PORT}/`,
    nativeConsole: `http://${HOST}:${PORT}/native.html`,
    hearthUrl: HEARTH_URL,
    cases: loaded.cases.length,
    providers: providers.list().length,
    recoveredRuns: recovered.interrupted,
    dataDir: DATA_DIR,
    artifactRoot: ARTIFACT_ROOT,
    web: WEB_DIST
  }, "hearth eval ready");
}

main().catch((error) => {
  console.error("[eval] failed to start", error);
  process.exitCode = 1;
});
