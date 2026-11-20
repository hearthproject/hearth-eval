import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  BenchmarkImportInput,
  BenchmarkImportResult,
  BenchmarkJobCandidate,
  BenchmarkRun
} from "@hearth/eval-core";
import {
  BENCHMARK_TRIAL_STATUSES,
  compareBenchmarkTrials,
  summarizeBenchmarkTasks,
  toBenchmarkCsv
} from "@hearth/eval-core";
import { BenchmarkImportError, importHarborJob, listHarborJobCandidates } from "./benchmark-import.ts";
import type { EvalStore } from "./store.ts";

const importSchema = z.object({
  jobDir: z.string().trim().min(1).max(1_024),
  datasetName: z.string().trim().min(1).max(200).optional(),
  datasetVersion: z.string().trim().min(1).max(80).optional(),
  datasetCommitSha: z.string().trim().min(1).max(80).optional(),
  datasetDigest: z.string().trim().min(1).max(200).optional(),
  datasetTaskCount: z.number().int().min(0).max(100_000).optional(),
  harnessName: z.string().trim().min(1).max(120).optional(),
  harnessVersion: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  pricing: z.object({
    inputPerMillionUsd: z.number().nonnegative(),
    outputPerMillionUsd: z.number().nonnegative(),
    cachedPerMillionUsd: z.number().nonnegative().optional()
  }).strict().optional(),
  dryRun: z.boolean().optional()
}).strict();

const trialQuerySchema = z.object({
  taskKey: z.string().trim().min(1).max(200).optional(),
  status: z.enum(BENCHMARK_TRIAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(200),
  offset: z.coerce.number().int().min(0).default(0)
}).strict();

const compareQuerySchema = z.object({
  baseline: z.string().trim().min(1).max(120)
}).strict();

const exportQuerySchema = z.object({
  format: z.literal("csv").default("csv")
}).strict();

const reimportSchema = z.object({
  jobDir: z.string().trim().min(1).max(1_024).optional()
}).strict();

export interface BenchmarkRouteOptions {
  store: EvalStore;
  jobsRoot: string;
}

function toImportInput(parsed: z.infer<typeof importSchema>): BenchmarkImportInput {
  return {
    jobDir: parsed.jobDir,
    datasetName: parsed.datasetName,
    datasetVersion: parsed.datasetVersion,
    datasetCommitSha: parsed.datasetCommitSha,
    datasetDigest: parsed.datasetDigest,
    datasetTaskCount: parsed.datasetTaskCount,
    harnessName: parsed.harnessName,
    harnessVersion: parsed.harnessVersion,
    model: parsed.model,
    pricing: parsed.pricing,
    dryRun: parsed.dryRun
  };
}

function zodMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

export async function registerBenchmarkRoutes(app: FastifyInstance, options: BenchmarkRouteOptions): Promise<void> {
  await app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: "INVALID_INPUT", message: zodMessage(error) });
      }
      if (error instanceof BenchmarkImportError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      const errorRecord = error !== null && typeof error === "object" ? error as { statusCode?: unknown } : {};
      const statusCode = typeof errorRecord.statusCode === "number" && errorRecord.statusCode >= 400 ? errorRecord.statusCode : 500;
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(statusCode).send({
        error: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED",
        message
      });
    });

    scope.get("/jobs", async (): Promise<{ root: string; jobs: BenchmarkJobCandidate[] }> => {
      return listHarborJobCandidates(options.jobsRoot);
    });

    scope.post("/import", async (request): Promise<BenchmarkImportResult> => {
      const parsed = importSchema.parse(request.body);
      return importHarborJob({
        store: options.store,
        jobsRoot: options.jobsRoot,
        input: toImportInput(parsed)
      });
    });

    scope.get("/", async (): Promise<{ runs: BenchmarkRun[] }> => {
      return { runs: options.store.benchmarks.listRuns() };
    });

    scope.get("/:id", async (request, reply) => {
      const params = z.object({ id: z.string().trim().min(1).max(120) }).strict().parse(request.params);
      const run = options.store.benchmarks.getRun(params.id);
      if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: `Benchmark run not found: ${params.id}` });
      const trials = options.store.benchmarks.listTrials(params.id);
      return { run, tasks: summarizeBenchmarkTasks(trials) };
    });

    scope.get("/:id/trials", async (request, reply) => {
      const params = z.object({ id: z.string().trim().min(1).max(120) }).strict().parse(request.params);
      const query = trialQuerySchema.parse(request.query);
      if (!options.store.benchmarks.getRun(params.id)) {
        return reply.code(404).send({ error: "RUN_NOT_FOUND", message: `Benchmark run not found: ${params.id}` });
      }
      const filter = {
        taskKey: query.taskKey,
        status: query.status,
        limit: query.limit,
        offset: query.offset
      };
      const trials = options.store.benchmarks.listTrials(params.id, filter);
      const total = options.store.benchmarks.countTrials(params.id, filter);
      return { trials, total, limit: query.limit, offset: query.offset };
    });

    scope.get("/:id/trials/:trialId", async (request, reply) => {
      const params = z.object({
        id: z.string().trim().min(1).max(120),
        trialId: z.string().trim().min(1).max(120)
      }).strict().parse(request.params);
      const trial = options.store.benchmarks.getTrial(params.id, params.trialId);
      if (!trial) return reply.code(404).send({ error: "TRIAL_NOT_FOUND", message: `Benchmark trial not found: ${params.trialId}` });
      return { trial };
    });

    scope.get("/:id/compare", async (request, reply) => {
      const params = z.object({ id: z.string().trim().min(1).max(120) }).strict().parse(request.params);
      const query = compareQuerySchema.parse(request.query);
      const candidate = options.store.benchmarks.getRun(params.id);
      if (!candidate) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: `Benchmark run not found: ${params.id}` });
      const baseline = options.store.benchmarks.getRun(query.baseline);
      if (!baseline) return reply.code(404).send({ error: "BASELINE_NOT_FOUND", message: `Benchmark baseline not found: ${query.baseline}` });
      if (baseline.datasetId !== candidate.datasetId) {
        return reply.code(400).send({
          error: "DATASET_MISMATCH",
          message: `Cannot compare ${baseline.datasetId} with ${candidate.datasetId}`
        });
      }
      const baselineTrials = options.store.benchmarks.listTrials(baseline.id, { limit: 1_000 });
      const candidateTrials = options.store.benchmarks.listTrials(candidate.id, { limit: 1_000 });
      return {
        baselineRun: baseline,
        candidateRun: candidate,
        comparison: compareBenchmarkTrials(
          baseline.id,
          candidate.id,
          baselineTrials,
          candidateTrials,
          baseline.model !== candidate.model
        )
      };
    });

    scope.get("/:id/export", async (request, reply) => {
      const params = z.object({ id: z.string().trim().min(1).max(120) }).strict().parse(request.params);
      exportQuerySchema.parse(request.query);
      if (!options.store.benchmarks.getRun(params.id)) {
        return reply.code(404).send({ error: "RUN_NOT_FOUND", message: `Benchmark run not found: ${params.id}` });
      }
      const trials = options.store.benchmarks.listTrials(params.id, { limit: 1_000 });
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="benchmark-${params.id}.csv"`)
        .send(toBenchmarkCsv(trials));
    });

    scope.post("/:id/reimport", async (request, reply) => {
      const params = z.object({ id: z.string().trim().min(1).max(120) }).strict().parse(request.params);
      const body = reimportSchema.parse(request.body ?? {});
      const run = options.store.benchmarks.getRun(params.id);
      if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: `Benchmark run not found: ${params.id}` });
      const dataset = options.store.benchmarks.getDataset(run.datasetId);
      if (!dataset) return reply.code(404).send({ error: "DATASET_NOT_FOUND", message: `Benchmark dataset not found: ${run.datasetId}` });
      const result = importHarborJob({
        store: options.store,
        jobsRoot: options.jobsRoot,
        input: {
          jobDir: body.jobDir ?? run.rawDir,
          datasetName: dataset.name,
          datasetVersion: dataset.version,
          datasetCommitSha: dataset.commitSha ?? undefined,
          datasetDigest: dataset.digest ?? undefined,
          datasetTaskCount: dataset.taskCount,
          harnessName: run.harnessName,
          harnessVersion: run.harnessVersion,
          model: run.model
        }
      });
      if (result.runId !== run.id) {
        return reply.code(409).send({
          error: "JOB_MISMATCH",
          message: `Reimport resolved to ${result.runId}, expected ${run.id}`
        });
      }
      return result;
    });
  }, { prefix: "/api/benchmarks" });
}
