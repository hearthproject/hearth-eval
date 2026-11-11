import { resolve } from "node:path";

const EVAL_ARTIFACT_PREFIX = ".hearth/eval-artifacts";

export function resolveRunOutputDir(repoRoot: string, artifactRoot: string, outputDir: string): string {
  const normalized = outputDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized === EVAL_ARTIFACT_PREFIX) return resolve(artifactRoot);
  if (normalized.startsWith(`${EVAL_ARTIFACT_PREFIX}/`)) {
    return resolve(artifactRoot, normalized.slice(EVAL_ARTIFACT_PREFIX.length + 1));
  }
  return resolve(repoRoot, outputDir);
}
