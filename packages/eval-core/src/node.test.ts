import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCaseCatalog, validateCatalogShape } from "./node.ts";
import { runGrader } from "./graders.ts";
import { EVAL_FAMILIES, type ArtifactMap } from "./types.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("case catalog", () => {
  it("loads exactly 60 valid cases across eight families", () => {
    const loaded = loadCaseCatalog(repoRoot);
    expect(loaded.issues).toEqual([]);
    expect(loaded.cases).toHaveLength(60);
    expect(validateCatalogShape(loaded.cases)).toEqual([]);
    const counts = Object.fromEntries(EVAL_FAMILIES.map((family) => [family, 0]));
    for (const loadedCase of loaded.cases) {
      const family = loadedCase.manifest.family;
      counts[family] = (counts[family] ?? 0) + 1;
    }
    expect(counts).toEqual({
      email: 8,
      calendar: 7,
      documents: 9,
      research: 8,
      code: 8,
      web: 8,
      desktop: 5,
      "cross-app": 7
    });
  });

  it("passes every deterministic grader against each offline golden artifact", () => {
    const loaded = loadCaseCatalog(repoRoot);
    const failures: string[] = [];
    for (const loadedCase of loaded.cases) {
      if (loadedCase.manifest.runModes.length === 1 && loadedCase.manifest.runModes[0] === "live-only") continue;
      const artifacts = readArtifacts(join(loadedCase.directory, "golden"));
      for (const criterion of loadedCase.manifest.criteria.filter((item) => item.source === "deterministic")) {
        const grader = loadedCase.manifest.graders.find((item) => item.id === criterion.graderId);
        if (!grader) {
          failures.push(`${loadedCase.manifest.id}/${criterion.id}: missing grader`);
          continue;
        }
        const result = runGrader(grader, artifacts);
        if (!result.passed) failures.push(`${loadedCase.manifest.id}/${criterion.id}: ${result.reason}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("E01 triage grading", () => {
  const loadedCase = loadCaseCatalog(repoRoot).cases.find((item) => item.manifest.id === "E01")!;
  const grader = loadedCase.manifest.graders.find((item) => item.id === "shape")!;
  const golden = JSON.parse(readFileSync(join(loadedCase.directory, "golden/triage.json"), "utf8")) as {
    items: Array<{ id: string; priority: string; action: string; reason: string }>;
  };

  function gradeItems(items: unknown) {
    const text = JSON.stringify({ items });
    return runGrader(grader, { "triage.json": { text, bytes: Buffer.byteLength(text) } });
  }

  it("covers exactly the input message IDs", () => {
    const input = JSON.parse(readFileSync(join(loadedCase.directory, "input.json"), "utf8")) as {
      messages: Array<{ id: string }>;
    };
    expect(golden.items.map((item) => item.id).sort()).toEqual(input.messages.map((item) => item.id).sort());
    expect(gradeItems(golden.items).passed).toBe(true);
  });

  it("accepts reordered answers and independently worded reasons", () => {
    const items = [...golden.items].reverse().map((item) => ({ ...item, reason: `邮件 ${item.id} 的分流说明` }));
    expect(gradeItems(items).passed).toBe(true);
  });

  it.each([
    ["missing message", golden.items.slice(0, 3), "缺少 id：m4"],
    ["duplicate replacing a message", [golden.items[0], golden.items[1], golden.items[2], golden.items[0]], "重复 id：m1"],
    ["extra duplicate", [...golden.items, golden.items[0]], "重复 id：m1"],
    ["unknown message", [...golden.items, { id: "m5", priority: "low" }], "未知 id：m5"],
    ["missing ID", [...golden.items.slice(0, 3), { priority: "medium" }], "缺少字符串键 id"],
    ["non-string ID", [...golden.items.slice(0, 3), { id: 4, priority: "medium" }], "缺少字符串键 id"],
    ["null item", [...golden.items.slice(0, 3), null], "缺少字符串键 id"],
    ["non-array items", {}, "必须是数组"],
    ["missing priority", [...golden.items.slice(0, 3), { id: "m4" }], "id=m4].priority"],
    ["wrong priority after reordering", golden.items.map((item) => item.id === "m1" ? { ...item, priority: "low" } : item).reverse(), "id=m1].priority"]
  ])("rejects %s with a useful reason", (_name, items, reason) => {
    const result = gradeItems(items);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it.each(golden.items.map((item) => item.id))("checks priority for %s by ID", (id) => {
    const items = golden.items.map((item) => item.id === id ? { ...item, priority: "invalid" } : item);
    expect(gradeItems(items).passed).toBe(false);
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
    const text = readFileSync(absolute, "utf8");
    artifacts[relative] = { text, bytes: statSync(absolute).size };
  }
  return artifacts;
}
