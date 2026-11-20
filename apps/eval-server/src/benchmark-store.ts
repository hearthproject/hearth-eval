import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  BenchmarkDataset,
  BenchmarkImportDatasetInput,
  BenchmarkImportRunInput,
  BenchmarkRun,
  BenchmarkRunStatus,
  BenchmarkRunSummary,
  BenchmarkTask,
  BenchmarkTrial,
  BenchmarkTrialFilter,
  BenchmarkTrialStatus
} from "@hearth/eval-core";

type DbRow = Record<string, SQLInputValue>;

export interface BenchmarkTaskInput {
  id: string;
  datasetId: string;
  taskKey: string;
  instructionPath: string | null;
  imageRef: string | null;
  timeoutSec: number | null;
  metadata: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS benchmark_datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  commit_sha TEXT,
  digest TEXT,
  task_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmark_tasks (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  instruction_path TEXT,
  image_ref TEXT,
  timeout_sec REAL,
  metadata_json TEXT NOT NULL,
  UNIQUE(dataset_id, task_key)
);
CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  harness_name TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  config_json TEXT NOT NULL,
  raw_dir TEXT NOT NULL,
  summary_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, dataset_id, harness_name, harness_version, model)
);
CREATE TABLE IF NOT EXISTS benchmark_trials (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  trial_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  reward REAL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  reward_path TEXT,
  result_path TEXT,
  error_code TEXT,
  error_message TEXT,
  verifier_stdout TEXT,
  verifier_stderr TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, trial_key)
);
CREATE INDEX IF NOT EXISTS benchmark_trials_run_idx ON benchmark_trials(run_id, task_key);
CREATE INDEX IF NOT EXISTS benchmark_trials_status_idx ON benchmark_trials(run_id, status);
CREATE INDEX IF NOT EXISTS benchmark_runs_dataset_idx ON benchmark_runs(dataset_id, created_at);
`;

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeJson(value: unknown): BenchmarkRunSummary | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as BenchmarkRunSummary : null;
  } catch {
    return null;
  }
}

function mapDataset(row: DbRow): BenchmarkDataset {
  return {
    id: String(row.id),
    name: String(row.name),
    version: String(row.version),
    source: String(row.source),
    commitSha: textOrNull(row.commit_sha),
    digest: textOrNull(row.digest),
    taskCount: Number(row.task_count),
    createdAt: String(row.created_at)
  };
}

function mapTask(row: DbRow): BenchmarkTask {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    taskKey: String(row.task_key),
    instructionPath: textOrNull(row.instruction_path),
    imageRef: textOrNull(row.image_ref),
    timeoutSec: numberOrNull(row.timeout_sec),
    metadata: parseJsonObject(row.metadata_json)
  };
}

function mapRun(row: DbRow): BenchmarkRun {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    jobId: String(row.job_id),
    harnessName: String(row.harness_name),
    harnessVersion: String(row.harness_version),
    model: String(row.model),
    status: String(row.status) as BenchmarkRunStatus,
    startedAt: textOrNull(row.started_at),
    endedAt: textOrNull(row.ended_at),
    config: parseJsonObject(row.config_json),
    rawDir: String(row.raw_dir),
    summary: summarizeJson(row.summary_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapTrial(row: DbRow): BenchmarkTrial {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: String(row.task_id),
    taskKey: String(row.task_key),
    trialKey: String(row.trial_key),
    attempt: Number(row.attempt),
    reward: numberOrNull(row.reward),
    status: String(row.status) as BenchmarkTrialStatus,
    durationMs: numberOrNull(row.duration_ms) === null ? null : Math.trunc(Number(row.duration_ms)),
    inputTokens: numberOrNull(row.input_tokens) === null ? null : Math.trunc(Number(row.input_tokens)),
    outputTokens: numberOrNull(row.output_tokens) === null ? null : Math.trunc(Number(row.output_tokens)),
    cachedTokens: numberOrNull(row.cached_tokens) === null ? null : Math.trunc(Number(row.cached_tokens)),
    costUsd: numberOrNull(row.cost_usd),
    rewardPath: textOrNull(row.reward_path),
    resultPath: textOrNull(row.result_path),
    errorCode: textOrNull(row.error_code),
    errorMessage: textOrNull(row.error_message),
    verifierStdout: textOrNull(row.verifier_stdout),
    verifierStderr: textOrNull(row.verifier_stderr),
    raw: parseJsonValue(row.raw_json),
    createdAt: String(row.created_at)
  };
}

export class BenchmarkStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const runColumns = this.db.prepare("PRAGMA table_info(benchmark_runs)").all() as DbRow[];
    if (!runColumns.some((column) => column.name === "summary_json")) {
      this.db.exec("ALTER TABLE benchmark_runs ADD COLUMN summary_json TEXT");
    }
    if (!runColumns.some((column) => column.name === "updated_at")) {
      this.db.exec("ALTER TABLE benchmark_runs ADD COLUMN updated_at TEXT");
    }
    const trialColumns = this.db.prepare("PRAGMA table_info(benchmark_trials)").all() as DbRow[];
    if (!trialColumns.some((column) => column.name === "verifier_stdout")) {
      this.db.exec("ALTER TABLE benchmark_trials ADD COLUMN verifier_stdout TEXT");
    }
    if (!trialColumns.some((column) => column.name === "verifier_stderr")) {
      this.db.exec("ALTER TABLE benchmark_trials ADD COLUMN verifier_stderr TEXT");
    }
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error if rollback itself fails.
      }
      throw error;
    }
  }

  saveDataset(input: BenchmarkImportDatasetInput): BenchmarkDataset {
    this.db.prepare(`
      INSERT INTO benchmark_datasets (id, name, version, source, commit_sha, digest, task_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        version=excluded.version,
        source=excluded.source,
        commit_sha=excluded.commit_sha,
        digest=excluded.digest,
        task_count=excluded.task_count
    `).run(
      input.id,
      input.name,
      input.version,
      input.source,
      input.commitSha,
      input.digest,
      input.taskCount,
      input.createdAt
    );
    return this.getDataset(input.id) as BenchmarkDataset;
  }

  getDataset(id: string): BenchmarkDataset | null {
    const row = this.db.prepare("SELECT * FROM benchmark_datasets WHERE id = ?").get(id);
    return row ? mapDataset(row as DbRow) : null;
  }

  upsertTask(input: BenchmarkTaskInput): BenchmarkTask {
    this.db.prepare(`
      INSERT INTO benchmark_tasks (id, dataset_id, task_key, instruction_path, image_ref, timeout_sec, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dataset_id=excluded.dataset_id,
        task_key=excluded.task_key,
        instruction_path=excluded.instruction_path,
        image_ref=excluded.image_ref,
        timeout_sec=excluded.timeout_sec,
        metadata_json=excluded.metadata_json
    `).run(
      input.id,
      input.datasetId,
      input.taskKey,
      input.instructionPath,
      input.imageRef,
      input.timeoutSec,
      stringifyJson(input.metadata)
    );
    const row = this.db.prepare("SELECT * FROM benchmark_tasks WHERE id = ?").get(input.id);
    return mapTask(row as DbRow);
  }

  saveRun(input: BenchmarkImportRunInput): BenchmarkRun {
    this.db.prepare(`
      INSERT INTO benchmark_runs (
        id, dataset_id, job_id, harness_name, harness_version, model, status,
        started_at, ended_at, config_json, raw_dir, summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dataset_id=excluded.dataset_id,
        job_id=excluded.job_id,
        harness_name=excluded.harness_name,
        harness_version=excluded.harness_version,
        model=excluded.model,
        status=excluded.status,
        started_at=excluded.started_at,
        ended_at=excluded.ended_at,
        config_json=excluded.config_json,
        raw_dir=excluded.raw_dir,
        updated_at=excluded.updated_at
    `).run(
      input.id,
      input.datasetId,
      input.jobId,
      input.harnessName,
      input.harnessVersion,
      input.model,
      input.status,
      input.startedAt,
      input.endedAt,
      stringifyJson(input.config),
      input.rawDir,
      input.createdAt,
      input.updatedAt
    );
    return this.getRun(input.id) as BenchmarkRun;
  }

  getRun(id: string): BenchmarkRun | null {
    const row = this.db.prepare("SELECT * FROM benchmark_runs WHERE id = ?").get(id);
    return row ? mapRun(row as DbRow) : null;
  }

  listRuns(limit = 200): BenchmarkRun[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.db.prepare("SELECT * FROM benchmark_runs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(safeLimit)
      .map((row) => mapRun(row as DbRow));
  }

  replaceTrials(runId: string, trials: BenchmarkTrial[]): void {
    this.db.prepare("DELETE FROM benchmark_trials WHERE run_id = ?").run(runId);
    for (const trial of trials) {
      this.db.prepare(`
        INSERT INTO benchmark_trials (
          id, run_id, task_id, task_key, trial_key, attempt, reward, status, duration_ms,
          input_tokens, output_tokens, cached_tokens, cost_usd, reward_path, result_path,
          error_code, error_message, verifier_stdout, verifier_stderr, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trial.id,
        trial.runId,
        trial.taskId,
        trial.taskKey,
        trial.trialKey,
        trial.attempt,
        trial.reward,
        trial.status,
        trial.durationMs,
        trial.inputTokens,
        trial.outputTokens,
        trial.cachedTokens,
        trial.costUsd,
        trial.rewardPath,
        trial.resultPath,
        trial.errorCode,
        trial.errorMessage,
        trial.verifierStdout,
        trial.verifierStderr,
        stringifyJson(trial.raw),
        trial.createdAt
      );
    }
  }

  listTrials(runId: string, filter: BenchmarkTrialFilter = {}): BenchmarkTrial[] {
    const where: string[] = ["run_id = ?"];
    const params: SQLInputValue[] = [runId];
    if (filter.taskKey) {
      where.push("task_key = ?");
      params.push(filter.taskKey);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const limit = Math.max(1, Math.min(1_000, Math.trunc(filter.limit ?? 500)));
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
    params.push(limit, offset);
    return this.db.prepare(`
      SELECT * FROM benchmark_trials
      WHERE ${where.join(" AND ")}
      ORDER BY task_key ASC, attempt ASC, trial_key ASC
      LIMIT ? OFFSET ?
    `).all(...params).map((row) => mapTrial(row as DbRow));
  }

  countTrials(runId: string, filter: Pick<BenchmarkTrialFilter, "taskKey" | "status"> = {}): number {
    const where: string[] = ["run_id = ?"];
    const params: SQLInputValue[] = [runId];
    if (filter.taskKey) {
      where.push("task_key = ?");
      params.push(filter.taskKey);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM benchmark_trials WHERE ${where.join(" AND ")}`).get(...params);
    return Number((row as DbRow | undefined)?.count ?? 0);
  }

  getTrial(runId: string, trialId: string): BenchmarkTrial | null {
    const row = this.db.prepare("SELECT * FROM benchmark_trials WHERE run_id = ? AND id = ?").get(runId, trialId);
    return row ? mapTrial(row as DbRow) : null;
  }

  updateRunSummary(runId: string, status: BenchmarkRunStatus, summary: BenchmarkRunSummary, endedAt: string | null): void {
    this.db.prepare(`
      UPDATE benchmark_runs
      SET status = ?, summary_json = ?, ended_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, stringifyJson(summary), endedAt, new Date().toISOString(), runId);
  }
}
