import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchmarkImportInput, BenchmarkPricing } from "@hearth/eval-core";
import { DB_PATH, HARBOR_JOBS_ROOT } from "./config.ts";
import { EvalStore } from "./store.ts";
import { BenchmarkImportError, importHarborJob } from "./benchmark-import.ts";

export interface BenchmarkCliOptions {
  job: string | null;
  datasetName: string | null;
  datasetVersion: string | null;
  harnessName: string | null;
  harnessVersion: string | null;
  model: string | null;
  jobsRoot: string | null;
  db: string | null;
  pricing: BenchmarkPricing | null;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

const HELP = `Usage:
  npm run bench:import -- --job <job-dir> [options]

Required:
  --job <name>                 Harbor job directory, relative to --jobs-root or absolute

Options:
  --dataset <name>             Dataset name (default: terminal-bench/terminal-bench-2-1)
  --version <version>          Dataset version (default: 2.1)
  --harness <name>             Harness name (default: from job config, then hearth-native)
  --harness-version <version>  Harness version (default: from job config, then unknown)
  --model <name>               Model name (default: from job config, then unknown)
  --jobs-root <path>           Harbor jobs root (default: HEARTH_EVAL_HARBOR_JOBS_ROOT or ./harbor-jobs)
  --db <path>                  SQLite database (default: HEARTH_EVAL data dir)
  --pricing-input <usd>        Input price per 1M tokens
  --pricing-output <usd>       Output price per 1M tokens
  --pricing-cached <usd>       Cached input price per 1M tokens
  --dry-run                    Parse and summarize without writing
  --json                       Print the complete import result as JSON
  --help                       Show this help

Examples:
  npm run bench:import -- --job 2026-11-20__12-00-00
  npm run bench:import -- --job harbor-job-mini --dry-run --json
`;

function optionalString(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

function price(value: string | undefined, name: string): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

export function parseBenchmarkCliArgs(args: string[]): BenchmarkCliOptions {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      job: { type: "string" },
      dataset: { type: "string" },
      version: { type: "string" },
      harness: { type: "string" },
      "harness-version": { type: "string" },
      model: { type: "string" },
      "jobs-root": { type: "string" },
      db: { type: "string" },
      "pricing-input": { type: "string" },
      "pricing-output": { type: "string" },
      "pricing-cached": { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" }
    }
  });

  const inputPrice = price(values["pricing-input"], "--pricing-input");
  const outputPrice = price(values["pricing-output"], "--pricing-output");
  const cachedPrice = price(values["pricing-cached"], "--pricing-cached");
  if (cachedPrice !== null && (inputPrice === null || outputPrice === null)) {
    throw new Error("--pricing-cached requires --pricing-input and --pricing-output");
  }
  const pricing = inputPrice !== null || outputPrice !== null
    ? {
        inputPerMillionUsd: inputPrice ?? 0,
        outputPerMillionUsd: outputPrice ?? 0,
        ...(cachedPrice !== null ? { cachedPerMillionUsd: cachedPrice } : {})
      }
    : null;

  return {
    job: optionalString(values.job),
    datasetName: optionalString(values.dataset),
    datasetVersion: optionalString(values.version),
    harnessName: optionalString(values.harness),
    harnessVersion: optionalString(values["harness-version"]),
    model: optionalString(values.model),
    jobsRoot: optionalString(values["jobs-root"]),
    db: optionalString(values.db),
    pricing,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    help: values.help === true
  };
}

function formatSummary(result: ReturnType<typeof importHarborJob>): string {
  const reward = result.summary.meanReward === null ? "—" : `${(result.summary.meanReward * 100).toFixed(1)}%`;
  const lines = [
    `Imported ${result.jobId} as ${result.runId}`,
    `Dataset: ${result.datasetId}`,
    `Trials: ${result.trialCount} across ${result.taskCount} tasks`,
    `Mean reward: ${reward}`,
    `Tokens: ${result.summary.totalTokens}`,
    `Warnings: ${result.warnings.length}`
  ];
  if (result.warnings.length > 0) {
    lines.push(...result.warnings.map((warning) => `  - ${warning}`));
  }
  return lines.join("\n");
}

function run(): void {
  let options: BenchmarkCliOptions;
  try {
    options = parseBenchmarkCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`bench:import: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!options.job) {
    console.error("bench:import: --job is required\n");
    console.error(HELP);
    process.exitCode = 2;
    return;
  }

  const dbPath = resolve(options.db ?? DB_PATH);
  const jobsRoot = resolve(options.jobsRoot ?? HARBOR_JOBS_ROOT);
  const input: BenchmarkImportInput = {
    jobDir: options.job,
    datasetName: options.datasetName ?? undefined,
    datasetVersion: options.datasetVersion ?? undefined,
    harnessName: options.harnessName ?? undefined,
    harnessVersion: options.harnessVersion ?? undefined,
    model: options.model ?? undefined,
    pricing: options.pricing ?? undefined,
    dryRun: options.dryRun
  };

  const store = new EvalStore(dbPath);
  try {
    const result = importHarborJob({ store, jobsRoot, input });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatSummary(result));
  } catch (error) {
    if (error instanceof BenchmarkImportError) {
      console.error(`bench:import: ${error.code}: ${error.message}`);
    } else {
      console.error(`bench:import: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run();
}
