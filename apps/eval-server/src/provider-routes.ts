import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import { LLM_PROVIDER_KINDS, type NativeProviderInput } from "@hearth/eval-core";
import type { ProviderStore } from "./provider-store.ts";
import { ProviderError } from "./providers.ts";

const providerInputSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().max(80).default(""),
  kind: z.enum(LLM_PROVIDER_KINDS).default("openai-compatible"),
  baseUrl: z.string().trim().max(300).optional(),
  model: z.string().trim().max(120).default(""),
  apiKey: z.string().max(400).optional(),
  maxSteps: z.number().int().min(1).max(40).optional(),
  temperature: z.number().min(0).max(2).optional(),
  clearApiKey: z.boolean().optional(),
  toolArgumentFormat: z.enum(["string", "object"]).optional(),
  promptStyle: z.enum(["chatml", "harmony"]).optional()
}).strict();

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(80) });

/** Drop `undefined` so the values fit `exactOptionalPropertyTypes` inputs. */
function toProviderInput(data: z.infer<typeof providerInputSchema>): NativeProviderInput {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) input[key] = value;
  }
  return input as unknown as NativeProviderInput;
}

export function registerProviderRoutes(app: FastifyInstance, providers: ProviderStore): void {
  app.get("/api/providers", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { providers: providers.list() };
  });

  app.post("/api/providers", async (request, reply) => {
    const parsed = providerInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_PROVIDER", message: "模型配置不正确", issues: parsed.error.issues });
    }
    try {
      return reply.code(201).send(providers.save(toProviderInput(parsed.data)));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    const parsed = providerInputSchema.safeParse({ ...(asRecord(request.body) ?? {}), id: request.params.id });
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_PROVIDER", message: "模型配置不正确", issues: parsed.error.issues });
    }
    try {
      return providers.save(toProviderInput(parsed.data));
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PROVIDER_ID", message: "模型配置 ID 不正确" });
    const removed = providers.remove(parsed.data.id);
    if (!removed) return reply.code(404).send({ error: "PROVIDER_NOT_FOUND", message: "模型配置不存在" });
    return { ok: true };
  });

  app.post("/api/providers/test", async (request, reply) => {
    const parsed = providerInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_PROVIDER", message: "模型配置不正确", issues: parsed.error.issues });
    }
    try {
      const result = await providers.test(toProviderInput(parsed.data));
      return result;
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sendProviderError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProviderError) {
    const status = error.code === "PROVIDER_NOT_FOUND" ? 404 : error.code === "PROVIDER_UNSUPPORTED" ? 400 : 400;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({ error: "PROVIDER_INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) });
}
