import { describe, expect, it } from "vitest";
import { evaluateChecks, evaluateSubmission, evaluationChecksSchema, textChecks, type EvaluationCheck } from "./evaluation.ts";
import { calibrationStats, runCalibration } from "./calibration.ts";
import { runGrader } from "./graders.ts";

const rules: EvaluationCheck[] = [{ id: "state", title: "草稿", weight: 9, blocker: true,
  config: { kind: "json", path: "output.txt", equals: { sent: false } } },
  { id: "note", title: "说明", weight: 1, blocker: false, config: { kind: "text", path: "output.txt", includes: ["note"] } }];

describe("shared artifact evaluation", () => {
  it("uses the same grader outcome as experiments and preserves weighted scores", () => {
    const text = '{"sent":false}';
    expect(evaluateSubmission(text, rules)).toMatchObject({ score: 90, verdict: "fail", scoringVersion: "checks-v1" });
    expect(runGrader(rules[0]!, { "output.txt": { text, bytes: text.length } }).passed).toBe(true);
    expect(evaluateSubmission('{"sent":true,"note":"ok"}', rules)).toMatchObject({ score: 0, verdict: "fail" });
  });
  it("separates missing observations, invalid rules and malformed deliverables", () => {
    expect(evaluateChecks(rules, {})).toMatchObject({ score: null, verdict: "unknown" });
    expect(evaluateSubmission("{broken", rules)).toMatchObject({ score: 0, verdict: "fail" });
    const invalid = [{ ...rules[0]!, config: { kind: "text" as const, path: "output.txt", regex: ["["] } }];
    expect(evaluateSubmission("anything", invalid)).toMatchObject({ score: null, verdict: "grader_error" });
    expect(evaluateChecks([], {})).toMatchObject({ score: null, verdict: "grader_error" });
  });
  it("keeps legacy text scores while exposing their limited meaning", () => {
    expect(evaluateSubmission("没有测试，也不能确认通过", textChecks(["测试", "通过"])).score).toBe(100);
    expect(evaluateSubmission("测试", textChecks(["测试", "通过"])).score).toBe(50);
  });
  it("does not turn an unexpected reader fault into a task failure", () => {
    const artifacts = Object.defineProperty({}, "output.txt", { get() { throw new Error("reader unavailable"); } });
    expect(evaluateChecks(rules, artifacts)).toMatchObject({ score: null, verdict: "grader_error" });
  });
  it("rejects duplicate IDs, invalid paths, trace and empty assertions", () => {
    for (const input of [[], [rules[0], rules[0]], [{ ...rules[0], config: { kind: "trace", maxSteps: 1 } }],
      [{ ...rules[0], config: { kind: "json", path: "output.txt" } }],
      [{ ...rules[0], config: { kind: "file", path: "other.txt" } }]]) {
      expect(evaluationChecksSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("calibration statistics", () => {
  it("uses expected-negative and expected-positive denominators and counts errors separately", () => {
    const base = { ruleSetId: "a", category: "test", score: null, rationale: "label", reasons: [] };
    const report = calibrationStats([
      { ...base, id: "1", expected: "fail", actual: "pass" },
      { ...base, id: "2", expected: "fail", actual: "fail" },
      { ...base, id: "3", expected: "pass", actual: "fail" },
      { ...base, id: "4", expected: "pass", actual: "grader_error" },
      { ...base, id: "5", expected: "pass", actual: "unknown" }
    ]);
    expect(report).toMatchObject({ falsePass: 1, falseFail: 1, falsePassRate: 50, falseFailRate: 33.33, coverage: 60, accuracy: 20, graderError: 1, unknown: 1 });
    expect(calibrationStats([])).toMatchObject({ accuracy: null, falsePassRate: null, falseFailRate: null });
  });
  it("requires traceable labels and valid rule references", () => {
    expect(() => runCalibration({ version: "test", labelStatus: "human_reviewed", ruleSets: [{ id: "a", title: "a", checks: rules }],
      samples: [{ id: "s", ruleSetId: "missing", category: "test", text: "{}", expected: "pass", rationale: "reason" }] })).toThrow();
  });
});
