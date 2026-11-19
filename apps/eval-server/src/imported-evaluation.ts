import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { evaluateSubmission, evaluationChecksSchema, textChecks, type ImportedEvaluation, type EvaluationCheck } from "@hearth/eval-core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EvalStore } from "./store.ts";
import { generateCodexRules } from "./codex-rule-generator.ts";
import { calibrationReport } from "./calibration.ts";

const agentSchema = z.object({
  agent: z.string().trim().min(1).max(100),
  version: z.string().trim().max(100)
}).strict();

const artifactSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  text: z.string().max(40_000).refine((value) => value.trim().length > 0 && !value.includes("\0"))
}).strict();

const textRulesSchema = z.array(z.string().trim().min(1).max(200)).max(20)
  .refine((values) => new Set(values.map((value) => value.toLocaleLowerCase())).size === values.length);
const requiredTextSchema = textRulesSchema.refine((values) => values.length > 0);
const generatedRulesSchema = z.object({
  requiredText: textRulesSchema,
  unsupported: z.array(z.string().trim().min(1).max(300)).max(20)
}).strict();
const generationRequestSchema = z.object({ description: z.string().trim().min(1).max(3000) }).strict();
const taskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(8_000),
  input: z.string().max(40_000),
  expectedOutput: z.string().trim().min(1).max(2_000),
  requiredText: textRulesSchema.default([]),
  checks: evaluationChecksSchema.optional()
}).strict();
const codexTurnSchema = z.object({ text: artifactSchema.shape.text, requiredText: requiredTextSchema }).strict();
const hasRules = (task: { requiredText: string[]; checks?: unknown }) => task.checks ? task.requiredText.length === 0 : task.requiredText.length > 0;
const evaluationSchema = taskSchema.extend({ submissions: z.array(agentSchema.merge(artifactSchema)).length(2) }).refine(hasRules, "文字检查与结构化检查必须且只能选择一种");
const batchSchema = taskSchema.extend({ agents: z.array(agentSchema).length(2) }).refine(hasRules, "文字检查与结构化检查必须且只能选择一种");
const hookSubmissionSchema = artifactSchema.extend({
  slot: z.number().int().min(1).max(2),
  runId: z.string().trim().min(1).max(200),
  metadata: z.object({
    durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    log: z.string().max(40_000).optional()
  }).strict().optional()
});

function scoreSubmission(text: string, requiredText: string[], checks?: EvaluationCheck[]): ImportedEvaluation["results"][number] {
  return { ...evaluateSubmission(text, checks ?? textChecks(requiredText)), mode: checks ? "artifact_checks" : "text_compliance" };
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function registerImportedEvaluationRoutes(app: FastifyInstance, store: EvalStore): void {
  app.get("/api/evaluation/calibration", async () => calibrationReport());
  let generatingRules = false;
  app.post("/api/codex/generate-rules", async (request, reply) => {
    const origin = URL.parse(request.headers.origin ?? "");
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
    if (!local.includes(request.ip) || (request.headers.origin &&
        (!origin || origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)))) {
      return reply.code(403).send({ message: "请在运行 Eval 的电脑上打开本机网页生成规则。" });
    }
    const input = generationRequestSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ message: "请描述评测目标，最多 3000 字符。" });
    if (generatingRules) return reply.code(409).send({ message: "Codex 正在生成规则，请稍候再试。" });
    generatingRules = true;
    try {
      const output = generatedRulesSchema.safeParse(await generateCodexRules(input.data.description));
      if (!output.success) return reply.code(502).send({ message: "Codex 返回的规则格式无效，请改写描述后重试。" });
      return reply.header("Cache-Control", "no-store").send(output.data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      request.log.warn({ code }, "Codex rule generation failed");
      return reply.code(502).send({ message: "Codex 未能完成生成。请确认本机已安装并登录 Codex CLI，然后重试。" });
    } finally {
      generatingRules = false;
    }
  });
  app.get("/api/codex/scores", async (request, reply) => {
    const query = z.object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)
      .default(Number.MAX_SAFE_INTEGER) }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ message: "评分记录分页参数无效。" });
    return reply.header("Cache-Control", "no-store").send(store.listCodexScores(query.data.before));
  });
  app.post("/api/codex/score-turn", async (request, reply) => {
    const parsed = codexTurnSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "Codex 回复或文本检查项无效。" });
    const { text, requiredText } = parsed.data;
    const { score, checks } = scoreSubmission(text, requiredText);
    if (score === null) return reply.code(500).send({ message: "文本检查器未能完成评分" });
    store.saveCodexScore({
      createdAt: new Date().toISOString(),
      score,
      checks: checks.map((check, index) => ({
        requiredText: requiredText[index]!,
        passed: check.passed === true,
        reason: check.reason
      }))
    });
    return { score, passed: checks.filter((check) => check.passed).length, total: checks.length };
  });
  app.get("/api/imported-evaluations", async () => store.listImportedEvaluations());
  app.get<{ Params: { id: string } }>("/api/imported-evaluations/:id", async (request, reply) => {
    return store.getImportedEvaluation(request.params.id)
      ?? reply.code(404).send({ error: "IMPORTED_EVALUATION_NOT_FOUND", message: "找不到这份评测" });
  });
  app.post("/api/imported-evaluations", async (request, reply) => {
    const parsed = evaluationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_IMPORTED_EVALUATION",
        message: "请填写任务信息、两份有效交付物，以及 1–20 条文字检查或结构化规则（二选一）。",
        issues: parsed.error.issues
      });
    }

    const results = parsed.data.submissions.map(({ text }) => scoreSubmission(text, parsed.data.requiredText, parsed.data.checks));
    const evaluation: ImportedEvaluation = {
      ...parsed.data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      results
    };
    store.saveImportedEvaluation(evaluation);
    return reply.code(201).send(evaluation);
  });
  app.post("/api/imported-evaluations/batches", async (request, reply) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请填写任务、两组 Agent 信息，以及文字检查或结构化规则（二选一）。", issues: parsed.error.issues });
    const token = randomBytes(32).toString("base64url");
    const evaluation: ImportedEvaluation = {
      ...parsed.data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      submissions: [],
      results: []
    };
    store.saveImportedEvaluation(evaluation, hashToken(token).toString("hex"));
    return reply.header("Cache-Control", "no-store").code(201).send({ evaluation, token });
  });
  app.post<{ Params: { id: string } }>("/api/imported-evaluations/:id/submissions", async (request, reply) => {
    const parsed = hookSubmissionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "提交内容无效。" });
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
    const { slot, runId, fileName, text, metadata } = parsed.data;

    // Two agents can submit simultaneously. Retry the compare-and-swap against the latest snapshot.
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = store.getImportedBatch(request.params.id);
      if (!stored || !token || !timingSafeEqual(hashToken(token), Buffer.from(stored.tokenHash, "hex"))) {
        return reply.code(401).send({ message: "批次凭证无效。" });
      }
      const evaluation = JSON.parse(stored.payload) as ImportedEvaluation;
      const existingIndex = evaluation.submissions.findIndex((submission) => submission.slot === slot);
      if (existingIndex >= 0) {
        const existing = evaluation.submissions[existingIndex]!;
        if (existing.runId !== runId || existing.fileName !== fileName || existing.text !== text ||
            JSON.stringify(existing.metadata) !== JSON.stringify(metadata)) {
          return reply.code(409).send({ message: "这个 Agent 槽位已有不同的提交。" });
        }
        return { duplicate: true, result: evaluation.results[existingIndex] };
      }
      const agent = evaluation.agents?.[slot - 1];
      if (!agent) return reply.code(400).send({ message: "Agent 槽位不存在。" });
      const result = scoreSubmission(text, evaluation.requiredText, evaluation.checks);
      evaluation.submissions.push({ ...agent, slot, runId, fileName, text, ...(metadata ? { metadata } : {}) });
      evaluation.results.push(result);
      if (store.updateImportedBatch(evaluation, stored.payload)) return reply.code(201).send({ duplicate: false, result });
    }
    return reply.code(503).send({ message: "批次正在更新，请重试提交。" });
  });
}
