import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCaseCatalog } from "./node.ts";
import { runGrader } from "./graders.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("E01 triage grading", () => {
  const loadedCase = loadCaseCatalog(repoRoot, "eval/catalog/v1/cases").cases.find((item) => item.manifest.id === "E01")!;
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
