import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DiagnosisAgent } from "./diagnosis-agent.ts";
import type { EvalStore } from "./store.ts";

export function registerDiagnosisRoutes(app: FastifyInstance, agent: DiagnosisAgent, store: EvalStore) {
  app.get("/api/diagnoses", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return store.listDiagnoses().map(({ evidence, ...job }) => ({ ...job, evidenceCount: evidence.length }));
  });
  app.get<{ Params: { id: string } }>("/api/diagnoses/:id", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return store.getDiagnosis(request.params.id) ?? reply.code(404).send({ message: "诊断不存在" });
  });
  // Starting a local model or rerunning a task is a mutation; reject cross-origin browser requests.
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || !request.url.startsWith("/api/diagnoses")) return;
    const origin = URL.parse(request.headers.origin ?? "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) ||
      (request.headers.origin && (!origin || origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
      return reply.code(403).send({ message: "请从本机 Eval 页面操作诊断" });
    }
  });
  app.post("/api/diagnoses", async (request, reply) => {
    const input = z.object({ experimentId: z.string().min(1).max(200), rerunBudget: z.number().int().min(0).max(1).default(0) }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ message: "请选择实验，复跑预算只能为 0 或 1" });
    try { return reply.code(202).send(agent.start(input.data.experimentId, input.data.rerunBudget)); }
    catch (error) { return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) }); }
  });
  for (const action of ["approve", "resume", "stop"] as const) {
    app.post<{ Params: { id: string } }>(`/api/diagnoses/:id/${action}`, async (request, reply) => {
      try {
        if (action === "approve") {
          const parsed = z.object({ approved: z.boolean() }).strict().safeParse(request.body);
          if (!parsed.success) return reply.code(400).send({ message: "需要明确同意或拒绝复跑" });
          return agent.approve(request.params.id, parsed.data.approved);
        }
        return action === "resume" ? agent.resume(request.params.id) : agent.stop(request.params.id);
      } catch (error) { return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) }); }
    });
  }
}
