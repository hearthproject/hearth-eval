import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AcceptanceDefaults } from "@hearth/eval-core";
import { AcceptanceAgent, acceptanceInputSchema } from "./acceptance-agent.ts";

export async function registerAcceptanceRoutes(app: FastifyInstance, agent: AcceptanceAgent, hearthUrl: string) {
  await app.register(async local => {
    local.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const origin = URL.parse(request.headers.origin ?? "");
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) ||
        (request.headers.origin && (!origin || !["http:", "https:"].includes(origin.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
        return reply.code(403).send({ message: "交付验收仅允许本机操作" });
      }
    });
    local.setErrorHandler((error, _request, reply) => reply.code(400).send({ message: error instanceof Error ? error.message : "验收操作失败" }));
    local.get("/api/acceptance/defaults", async (): Promise<AcceptanceDefaults> => ({ desktopRoot: agent.root(),
      fileName: `hearth-acceptance-${randomUUID().slice(0, 8)}.md`, title: "Hearth 交付验收", requiredText: ["这是由 Hearth OS 生成的 Markdown 文件。", "执行与验收分离。"], hearthUrl }));
    local.get("/api/acceptance", async () => agent.list().slice(0, 100));
    local.get<{ Params: { key: string } }>("/api/acceptance/memory/:key", async request => agent.memory(request.params.key));
    local.put<{ Params: { key: string } }>("/api/acceptance/memory/:key", async request => agent.saveMemory(request.params.key, request.body));
    local.get<{ Params: { id: string } }>("/api/acceptance/:id", async request => agent.get(request.params.id));
    local.post("/api/acceptance", async (request, reply) => {
      const input = acceptanceInputSchema.parse(request.body);
      await agent.checkReviewer(input);
      return reply.code(202).send(agent.start(input));
    });
    local.post<{ Params: { id: string } }>("/api/acceptance/:id/resume", async request => agent.resume(request.params.id));
    local.post<{ Params: { id: string } }>("/api/acceptance/:id/stop", async request => agent.stop(request.params.id));
  });
}
