import { z } from "zod";
import { graderSpecSchema } from "./schema.ts";
import { runGrader } from "./graders.ts";
import type { ArtifactMap, GraderSpec } from "./types.ts";

export type CheckStatus = "pass" | "fail" | "unknown" | "grader_error";
export interface EvaluationCheck extends GraderSpec { weight: number; blocker: boolean }
export interface CheckResult {
  id: string; title: string; status: CheckStatus; passed: boolean | null;
  reason: string; evidence: string[]; weight: number; blocker: boolean;
}
export interface CheckEvaluation {
  score: number | null;
  verdict: CheckStatus;
  checks: CheckResult[];
  scoringVersion: "checks-v1";
}

// External submissions have one artifact, always available as output.txt.
// Trace assertions need independently collected observations and are not accepted here.
export const evaluationCheckSchema = graderSpecSchema.extend({
  weight: z.number().positive().max(100).default(1),
  blocker: z.boolean().default(false)
}).superRefine((check, ctx) => {
  const config = check.config;
  if (config.kind === "trace" || config.kind === "artifact_count") {
    ctx.addIssue({ code: "custom", message: "单文件评测不支持轨迹或产物数量检查", path: ["config"] });
  } else if (config.path !== "output.txt") {
    ctx.addIssue({ code: "custom", message: "提交文件统一使用 output.txt 路径", path: ["config", "path"] });
  }
  if (config.kind === "text" && (config.regex?.length || !(config.includes?.length || config.excludes?.length))) {
    ctx.addIssue({ code: "custom", message: "文本检查须包含 includes 或 excludes；外部规则不接受正则", path: ["config"] });
  }
  if (config.kind === "text" && [...config.includes ?? [], ...config.excludes ?? []].some(value => !value.trim())) {
    ctx.addIssue({ code: "custom", message: "文本断言不能是空字符串", path: ["config"] });
  }
  if (config.kind === "state" && Object.keys(config.expected).length === 0) {
    ctx.addIssue({ code: "custom", message: "状态检查至少需要一个预期字段", path: ["config"] });
  }
  if (config.kind === "csv" && !(config.requiredColumns?.length || config.requiredValues?.length || (config.minRows ?? 0) > 0)) {
    ctx.addIssue({ code: "custom", message: "CSV 检查至少需要一项断言", path: ["config"] });
  }
  if (config.kind === "json" && !(config.requiredPaths?.length || Object.keys(config.equals ?? {}).length || Object.keys(config.minArrayLength ?? {}).length || config.keyedArrays?.length)) {
    ctx.addIssue({ code: "custom", message: "JSON 检查至少需要一项断言", path: ["config"] });
  }
}).transform(check => check as EvaluationCheck);
export const evaluationChecksSchema = z.array(evaluationCheckSchema).min(1).max(20).refine(
  checks => new Set(checks.map(check => check.id)).size === checks.length, "检查项 ID 必须唯一"
);

export function textChecks(requiredText: string[]): EvaluationCheck[] {
  return requiredText.map((text, index) => ({ id: `text-${index + 1}`, title: text, weight: 1, blocker: false,
    config: { kind: "text", path: "output.txt", includes: [text] } }));
}

export function evaluateChecks(checks: EvaluationCheck[], artifacts: ArtifactMap): CheckEvaluation {
  const results: CheckResult[] = checks.map(check => {
    const base = { id: check.id, title: check.title, weight: check.weight, blocker: check.blocker };
    const parsed = evaluationCheckSchema.safeParse(check);
    if (!parsed.success) return { ...base, status: "grader_error", passed: null, reason: parsed.error.issues.map(i => i.message).join("；"), evidence: [] };
    // An absent collection is unknown; a supplied but malformed artifact is a real failure.
    if (!Object.hasOwn(artifacts, "output.txt")) return { ...base, status: "unknown", passed: null, reason: "未收集到提交产物", evidence: [] };
    const result = runGrader(check, artifacts);
    return { ...base, ...result, status: result.error ? "grader_error" : result.passed ? "pass" : "fail", passed: result.error ? null : result.passed };
  });
  const blocked = results.some(r => r.blocker && r.status === "fail");
  const error = !results.length || results.some(r => r.status === "grader_error");
  const unknown = results.some(r => r.status === "unknown");
  const total = results.reduce((sum, r) => sum + r.weight, 0);
  const score = blocked ? 0 : error || unknown ? null : Math.round(100 * results.reduce((sum, r) => sum + (r.passed ? r.weight : 0), 0) / total);
  return { score, verdict: blocked ? "fail" : error ? "grader_error" : unknown ? "unknown" : results.every(r => r.passed) ? "pass" : "fail", checks: results, scoringVersion: "checks-v1" };
}

export function evaluateSubmission(text: string, checks: EvaluationCheck[]): CheckEvaluation {
  return evaluateChecks(checks, { "output.txt": { text, bytes: new TextEncoder().encode(text).length } });
}
