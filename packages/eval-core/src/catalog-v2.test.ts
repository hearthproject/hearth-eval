import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCaseCatalog, validateCatalogShape } from "./node.ts";
import { runGrader } from "./graders.ts";
import type { ArtifactMap, EvalFamily } from "./types.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const catalogRoot = join(repoRoot, "eval", "catalog", "v2");
const casesDir = "eval/catalog/v2/cases";

interface CatalogMeta {
  matrix: Record<EvalFamily, number>;
  liveOnly: string[];
}

function catalogMeta(): CatalogMeta {
  return JSON.parse(readFileSync(join(catalogRoot, "catalog.json"), "utf8")) as CatalogMeta;
}

describe("catalog v2 staging", () => {
  it("matches the declared family matrix and keeps every case schema v2", () => {
    const loaded = loadCaseCatalog(repoRoot, casesDir);
    expect(loaded.issues).toEqual([]);
    expect(validateCatalogShape(loaded.cases)).toEqual([]);
    const counts = Object.fromEntries(Object.keys(catalogMeta().matrix).map((family) => [family, 0])) as Record<string, number>;
    for (const loadedCase of loaded.cases) {
      expect(loadedCase.manifest.schemaVersion).toBe(2);
      counts[loadedCase.manifest.family] = (counts[loadedCase.manifest.family] ?? 0) + 1;
    }
    expect(counts).toEqual(catalogMeta().matrix);
  });

  it("uses independent gates and annotates evaluation metrics", () => {
    const loaded = loadCaseCatalog(repoRoot, casesDir);
    const failures: string[] = [];
    for (const loadedCase of loaded.cases) {
      const criteria = loadedCase.manifest.criteria;
      if (!criteria.some((criterion) => (criterion.layer ?? "result") !== "result")) {
        failures.push(`${loadedCase.manifest.id}: 缺少独立门禁`);
      }
      if (!criteria.some((criterion) => criterion.metric)) {
        failures.push(`${loadedCase.manifest.id}: 未标注八项指标`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("passes every non-trace deterministic grader against golden artifacts", () => {
    const loaded = loadCaseCatalog(repoRoot, casesDir);
    const failures: string[] = [];
    for (const loadedCase of loaded.cases) {
      if (loadedCase.manifest.runModes.length === 1 && loadedCase.manifest.runModes[0] === "live-only") continue;
      const golden = join(loadedCase.directory, "golden");
      if (!existsSync(golden)) continue;
      const artifacts = readArtifacts(golden);
      for (const criterion of loadedCase.manifest.criteria.filter((item) => item.source === "deterministic")) {
        const grader = loadedCase.manifest.graders.find((item) => item.id === criterion.graderId);
        if (!grader || grader.config.kind === "trace") continue;
        const result = runGrader(grader, artifacts);
        if (!result.passed) failures.push(`${loadedCase.manifest.id}/${criterion.id}: ${result.reason}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

function readArtifacts(directory: string, prefix = ""): ArtifactMap {
  const artifacts: ArtifactMap = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(artifacts, readArtifacts(absolute, relative));
      continue;
    }
    artifacts[relative] = { text: readFileSync(absolute, "utf8"), bytes: statSync(absolute).size };
  }
  return artifacts;
}
