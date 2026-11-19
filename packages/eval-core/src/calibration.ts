import { z } from "zod";
import { evaluateSubmission, evaluationChecksSchema, type CheckStatus } from "./evaluation.ts";

export const calibrationSuiteSchema = z.object({
  version: z.string().min(1),
  labelStatus: z.enum(["seed_unreviewed", "human_reviewed"]),
  reviewedBy: z.string().min(1).optional(),
  ruleSets: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), checks: evaluationChecksSchema }).strict()).min(1),
  samples: z.array(z.object({
    id: z.string().min(1), ruleSetId: z.string().min(1), category: z.string().min(1),
    text: z.string().max(40_000), expected: z.enum(["pass", "fail"]), rationale: z.string().min(1)
  }).strict()).min(1)
}).strict().superRefine((suite, ctx) => {
  if (suite.labelStatus === "human_reviewed" && !suite.reviewedBy?.trim()) ctx.addIssue({ code: "custom", message: "人工标注集须记录 reviewedBy" });
  if (new Set(suite.ruleSets.map(r => r.id)).size !== suite.ruleSets.length || new Set(suite.samples.map(s => s.id)).size !== suite.samples.length) ctx.addIssue({ code: "custom", message: "规则集和样本 ID 必须唯一" });
  for (const sample of suite.samples) if (!suite.ruleSets.some(r => r.id === sample.ruleSetId)) ctx.addIssue({ code: "custom", message: `样本 ${sample.id} 引用了不存在的规则集` });
});
export interface CalibrationRow {
  id: string; ruleSetId: string; category: string; expected: "pass" | "fail";
  actual: CheckStatus; score: number | null; rationale: string; reasons: string[];
}
export function calibrationStats(rows: CalibrationRow[]) {
  const positive = rows.filter(r => r.expected === "pass").length;
  const negative = rows.length - positive;
  const falsePass = rows.filter(r => r.expected === "fail" && r.actual === "pass").length;
  const falseFail = rows.filter(r => r.expected === "pass" && r.actual === "fail").length;
  const unknown = rows.filter(r => r.actual === "unknown").length;
  const graderError = rows.filter(r => r.actual === "grader_error").length;
  const correct = rows.filter(r => r.actual === r.expected).length;
  const percent = (n: number, d: number) => d ? Math.round(n / d * 10000) / 100 : null;
  return { total: rows.length, positive, negative, correct, falsePass, falseFail, unknown, graderError,
    falsePassRate: percent(falsePass, negative), falseFailRate: percent(falseFail, positive),
    coverage: percent(rows.length - unknown - graderError, rows.length), accuracy: percent(correct, rows.length) };
}
export function runCalibration(input: unknown) {
  const suite = calibrationSuiteSchema.parse(input);
  const rows: CalibrationRow[] = suite.samples.map(sample => {
    const rules = suite.ruleSets.find(r => r.id === sample.ruleSetId)!;
    const result = evaluateSubmission(sample.text, rules.checks);
    return { id: sample.id, ruleSetId: sample.ruleSetId, category: sample.category, expected: sample.expected,
      actual: result.verdict, score: result.score, rationale: sample.rationale,
      reasons: result.checks.filter(c => c.status !== "pass").map(c => `${c.title}：${c.reason}`) };
  });
  return { version: suite.version, labelStatus: suite.labelStatus, reviewedBy: suite.reviewedBy ?? null,
    scoringVersion: "checks-v1", summary: calibrationStats(rows),
    groups: suite.ruleSets.map(r => ({ id: r.id, title: r.title, ...calibrationStats(rows.filter(row => row.ruleSetId === r.id)) })), rows };
}
export type CalibrationReport = ReturnType<typeof runCalibration>;
