import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { BenchmarkImportResult, BenchmarkRun } from "@hearth/eval-core";
import { registerBenchmarkRoutes } from "./benchmark-routes.ts";
import { EvalStore } from "./store.ts";

const fixtureRoot = fileURLToPath(new URL("../test/fixtures", import.meta.url));
const stores: EvalStore[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];

async function makeApp(store = new EvalStore(":memory:")) {
  stores.push(store);
  const app = Fastify();
  apps.push(app);
  await registerBenchmarkRoutes(app, { store, jobsRoot: fixtureRoot });
  return { app, store };
}

async function importJob(app: ReturnType<typeof Fastify>, jobDir: string, extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/benchmarks/import",
    payload: { jobDir, ...extra }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as BenchmarkImportResult;
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
});

describe("benchmark routes", () => {
  it("imports, lists, reads detail, filters trials, and exports CSV", async () => {
    const { app } = await makeApp();
    const jobs = await app.inject({ method: "GET", url: "/api/benchmarks/jobs" });
    expect(jobs.statusCode).toBe(200);
    expect((jobs.json() as { jobs: unknown[] }).jobs.length).toBeGreaterThanOrEqual(2);

    const imported = await importJob(app, "harbor-job-mini");
    expect(imported.trialCount).toBe(5);

    const list = await app.inject({ method: "GET", url: "/api/benchmarks" });
    expect(list.statusCode).toBe(200);
    const runs = (list.json() as { runs: BenchmarkRun[] }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.summary?.validTrials).toBe(3);

    const detail = await app.inject({ method: "GET", url: `/api/benchmarks/${imported.runId}` });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as { run: BenchmarkRun; tasks: Array<{ taskKey: string }> };
    expect(detailBody.tasks).toHaveLength(5);

    const trials = await app.inject({
      method: "GET",
      url: `/api/benchmarks/${imported.runId}/trials?taskKey=fix-permissions&limit=10`
    });
    expect(trials.statusCode).toBe(200);
    const trialsBody = trials.json() as { trials: Array<{ trialKey: string }>; total: number };
    expect(trialsBody.total).toBe(1);
    expect(trialsBody.trials[0]?.trialKey).toBe("fix-permissions__abc123");

    const trialId = (await app.inject({
      method: "GET",
      url: `/api/benchmarks/${imported.runId}/trials?taskKey=fix-permissions`
    }).then((response) => response.json() as { trials: Array<{ id: string }> })).trials[0]?.id;
    const trial = await app.inject({ method: "GET", url: `/api/benchmarks/${imported.runId}/trials/${trialId}` });
    expect(trial.statusCode).toBe(200);
    expect((trial.json() as { trial: { verifierStdout: string } }).trial.verifierStdout).toContain("passed");

    const csv = await app.inject({ method: "GET", url: `/api/benchmarks/${imported.runId}/export?format=csv` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("task_key");
    expect(csv.body).toContain("fix-permissions");
  });

  it("compares two runs from the same dataset", async () => {
    const { app } = await makeApp();
    const baseline = await importJob(app, "harbor-job-mini-alt");
    const candidate = await importJob(app, "harbor-job-mini");
    const compare = await app.inject({
      method: "GET",
      url: `/api/benchmarks/${candidate.runId}/compare?baseline=${baseline.runId}`
    });
    expect(compare.statusCode).toBe(200);
    const body = compare.json() as {
      comparison: { tasks: Array<{ taskKey: string; status: string }>; aggregate: { resolvedTaskDelta: number } };
      baselineRun: BenchmarkRun;
      candidateRun: BenchmarkRun;
    };
    expect(body.baselineRun.id).toBe(baseline.runId);
    expect(body.candidateRun.id).toBe(candidate.runId);
    expect(body.comparison.tasks.some((task) => task.taskKey === "fix-permissions")).toBe(true);
    expect(body.comparison.aggregate.resolvedTaskDelta).toBe(1);
  });

  it("reimports the same job and rejects a different job", async () => {
    const { app } = await makeApp();
    const imported = await importJob(app, "harbor-job-mini");
    const reimport = await app.inject({
      method: "POST",
      url: `/api/benchmarks/${imported.runId}/reimport`,
      payload: {}
    });
    expect(reimport.statusCode).toBe(200);
    expect((reimport.json() as BenchmarkImportResult).runId).toBe(imported.runId);

    const mismatch = await app.inject({
      method: "POST",
      url: `/api/benchmarks/${imported.runId}/reimport`,
      payload: { jobDir: "harbor-job-mini-alt" }
    });
    expect(mismatch.statusCode).toBe(409);
    expect((mismatch.json() as { error: string }).error).toBe("JOB_MISMATCH");
  });

  it("returns structured errors for invalid paths and inputs", async () => {
    const { app } = await makeApp();
    const invalid = await app.inject({ method: "POST", url: "/api/benchmarks/import", payload: {} });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { error: string }).error).toBe("INVALID_INPUT");

    const missing = await app.inject({
      method: "POST",
      url: "/api/benchmarks/import",
      payload: { jobDir: "not-a-job" }
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: string }).error).toBe("JOB_NOT_FOUND");

    const outside = mkdtempSync(join(tmpdir(), "hearth-benchmark-outside-"));
    const escaped = await app.inject({
      method: "POST",
      url: "/api/benchmarks/import",
      payload: { jobDir: outside }
    });
    expect(escaped.statusCode).toBe(403);
    expect((escaped.json() as { error: string }).error).toBe("JOB_OUTSIDE_ROOT");

    const missingRun = await app.inject({ method: "GET", url: "/api/benchmarks/br_missing" });
    expect(missingRun.statusCode).toBe(404);
  });

  it("rejects comparisons across datasets", async () => {
    const { app } = await makeApp();
    const baseline = await importJob(app, "harbor-job-mini");
    const other = await importJob(app, "harbor-job-mini", { datasetName: "other/dataset" });
    const compare = await app.inject({
      method: "GET",
      url: `/api/benchmarks/${other.runId}/compare?baseline=${baseline.runId}`
    });
    expect(compare.statusCode).toBe(400);
    expect((compare.json() as { error: string }).error).toBe("DATASET_MISMATCH");
  });
});
