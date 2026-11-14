import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScenarioBatchDetail, ScenarioBatchSummary } from "@hearth/eval-core";
import { SCENARIO_FAULTS, SCENARIO_MECHANISMS, SCENARIO_PRIORITIES } from "@hearth/eval-core";
import { z } from "zod";

const batchIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
export const reportSchema = z.object({
  version: z.literal(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  runs: z.array(z.object({
    scenarioId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i),
    title: z.string(),
    mechanism: z.enum(SCENARIO_MECHANISMS),
    priority: z.enum(SCENARIO_PRIORITIES),
    fault: z.enum(SCENARIO_FAULTS),
    repetition: z.number().int().positive(),
    status: z.enum(["passed", "failed", "error"]),
    durationMs: z.number().nonnegative(),
    evidencePath: z.string().nullable(),
    error: z.string().nullable(),
    assertions: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() }))
  }))
});

async function readJson(root: string, ...parts: string[]): Promise<unknown> {
  let path = root;
  try {
    if (!(await lstat(path)).isDirectory()) return null;
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      if (!(await lstat(path)).isDirectory()) return null;
    }
    path = join(path, parts[parts.length - 1]!);
    if (!(await lstat(path)).isFile()) return null;
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readScenarioBatch(root: string, id: string): Promise<ScenarioBatchDetail | null> {
  if (!batchIdPattern.test(id)) return null;
  return scenarioBatchFromReport(id, await readJson(root, id, "report.json"));
}

export function scenarioBatchFromReport(id: string, report: unknown): ScenarioBatchDetail | null {
  const result = reportSchema.safeParse(report);
  if (!result.success) return null;
  const { startedAt, completedAt, runs } = result.data;
  return {
    id,
    startedAt,
    completedAt,
    total: runs.length,
    passed: runs.filter((run) => run.status === "passed").length,
    runs: runs.map(({ evidencePath, ...run }) => ({ ...run, hasEvidence: Boolean(evidencePath) }))
  };
}

export async function listScenarioBatches(root: string): Promise<ScenarioBatchSummary[]> {
  let entries;
  try {
    if (!(await lstat(root)).isDirectory()) return [];
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const batches: ScenarioBatchSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const batch = await readScenarioBatch(root, entry.name);
    if (batch) {
      const { runs, ...summary } = batch;
      batches.push(summary);
    }
  }
  return batches.sort((left, right) => right.id.localeCompare(left.id));
}

export async function readScenarioEvidence(root: string, id: string, scenarioId: string, repetition: string) {
  const batch = await readScenarioBatch(root, id);
  const run = batch?.runs.find((item) => item.scenarioId === scenarioId && String(item.repetition) === repetition);
  if (!run?.hasEvidence) return null;
  return readJson(root, id, run.scenarioId, `run-${run.repetition}`, "evidence.json");
}
