import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { JudgeSettingsInput, StorageSettingsResponse } from "@hearth/eval-core";
import type { LocalJudge } from "./local-judge.ts";
import { StorageSettings, type StoragePaths } from "./storage-settings.ts";

const modelSchema = z.object({
  providerId: z.string().trim().min(1).max(60).optional(),
  providerName: z.string().trim().min(1).max(80).optional(),
  protocol: z.literal("openai-chat").optional(),
  baseUrl: z.string().trim().url().max(500).refine((value) => /^https?:\/\//i.test(value)).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  apiKey: z.string().max(500).optional()
}).strict();

function localRequest(request: FastifyRequest): boolean {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)) return false;
  if (!request.headers.origin) return true;
  try {
    const origin = new URL(request.headers.origin);
    return ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      && ["http:", "https:"].includes(origin.protocol);
  } catch { return false; }
}

export async function registerSystemSettingsRoutes(app: FastifyInstance, options: {
  repoRoot: string; current: StoragePaths;
  modelClient: Pick<LocalJudge, "modelSettings" | "saveModelSettings" | "testModelSettings">;
}) {
  const storage = new StorageSettings(options.repoRoot);
  const client = options.modelClient;
  const snapshot = (): StorageSettingsResponse => {
    const next = storage.effective();
    return { current: options.current, next,
      overrides: { dataDir: process.env.HEARTH_EVAL_DATA_DIR !== undefined, artifactRoot: process.env.HEARTH_EVAL_ARTIFACT_ROOT !== undefined },
      restartRequired: next.dataDir !== options.current.dataDir || next.artifactRoot !== options.current.artifactRoot };
  };
  await app.register(async (local) => {
    local.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!localRequest(request)) return reply.code(403).send({ message: "系统配置仅允许本机访问" });
    });
    local.setErrorHandler((error, _request, reply) => {
      return reply.code(400).send({ message: error instanceof Error ? error.message : "配置操作失败" });
    });
    local.get("/api/system/judge", async () => client.modelSettings());
    local.put("/api/system/judge", async (request) => {
      const input = modelSchema.parse(request.body) as JudgeSettingsInput;
      // An empty password field means preserve the existing key.
      if (!input.apiKey?.trim()) delete input.apiKey;
      const result = await client.saveModelSettings(input);
      return result;
    });
    local.post("/api/system/judge/test", async (request) => {
      const input = modelSchema.parse(request.body ?? {}) as JudgeSettingsInput;
      if (!input.apiKey?.trim()) delete input.apiKey;
      return client.testModelSettings(input);
    });
    local.get("/api/system/storage", async () => snapshot());
    local.put("/api/system/storage", async (request) => {
      const input = z.object({ dataDir: z.string().trim().min(1).max(4096), artifactRoot: z.string().trim().min(1).max(4096) }).strict().parse(request.body);
      const current = snapshot();
      for (const key of ["dataDir", "artifactRoot"] as const) {
        if (current.overrides[key] && resolve(input[key]) !== current.next[key]) throw new Error(`${key} 由环境变量指定，请先修改或移除对应环境变量再重启服务`);
      }
      storage.save(input);
      return snapshot();
    });
    local.get("/api/system/directories", async (request) => {
      const query = z.object({ path: z.string().min(1).max(4096).optional() }).strict().parse(request.query);
      const path = query.path ?? options.repoRoot;
      if (!isAbsolute(path)) throw new Error("请输入绝对目录");
      const absolute = resolve(path);
      const entries = await readdir(absolute, { withFileTypes: true });
      return { path: absolute, parent: dirname(absolute), directories: entries.filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ name: entry.name, path: join(absolute, entry.name) })) };
    });
  });
}
