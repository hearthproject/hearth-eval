import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactMap, EvalTaskRequest, RawTraceEvent } from "@hearth/eval-core";
import { buildEvalTrace } from "@hearth/eval-core";
import type { AgentAdapter, AgentArtifactRequest, AgentTaskView } from "./agent-adapter.ts";
import { resolveRunOutputDir } from "./artifact-path.ts";
import { resolveNativeCase } from "./native-cases.ts";
import { AgentLoop, normalizeRelative, type NativeTask } from "./native-agent.ts";
import { DirectoryTaskWorkspace, ProviderError } from "./providers.ts";
import type { ProviderStore } from "./provider-store.ts";
import type { NativeProviderView } from "@hearth/eval-core";

export interface NativeAgentClientOptions {
  repoRoot: string;
  artifactRoot: string;
  providers: ProviderStore;
  /** Upper bound for tasks kept in memory after they finish. */
  maxTasks?: number;
  /** Injection seam for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Implements the same `AgentAdapter` boundary as `HearthClient`, but the task is
 * executed locally by the agent loop against a user-configured LLM provider.
 */
export class NativeAgentClient implements AgentAdapter {
  readonly baseUrl = "native://local";
  private readonly options: NativeAgentClientOptions;
  private readonly tasks = new Map<string, NativeTask>();
  private readonly running = new Set<Promise<void>>();

  constructor(options: NativeAgentClientOptions) {
    this.options = options;
  }

  /** Executor id -> provider id, so `executorIds` in an experiment mean "this model config". */
  executorOptions(): Array<{ id: string; name: string; model: string; kind: string; apiKeyHint: string | null }> {
    return this.options.providers.list().map((provider) => ({
      id: provider.id,
      name: provider.name,
      model: provider.model,
      kind: provider.kind,
      apiKeyHint: provider.apiKeyHint
    }));
  }

  async executors(): Promise<Record<string, unknown>> {
    return {
      executors: this.executorOptions().map((provider) => ({
        id: provider.id,
        name: provider.name,
        description: `${provider.model} · ${provider.kind}`,
        capabilities: ["llm", "files"],
        health: { canRun: provider.apiKeyHint !== null, issues: provider.apiKeyHint === null ? ["缺少 API Key"] : [] }
      }))
    };
  }

  async createTask(body: EvalTaskRequest): Promise<{ task: { id: string; status: string }; created: boolean }> {
    const caseId = caseIdFromExternalRef(body.externalRef);
    let resolved: ReturnType<ProviderStore["resolve"]>;
    try {
      resolved = this.options.providers.resolve(body.executorId ?? "");
    } catch (error) {
      throw asTaskError(error);
    }
    const prepared = resolveNativeCase(this.options.repoRoot, caseId, body.inputs, body.outputDir);
    const outputDir = resolveRunOutputDir(this.options.repoRoot, this.options.artifactRoot, body.outputDir);
    const id = `native-${randomUUID()}`;
    const now = new Date().toISOString();
    const task: NativeTask = {
      id,
      status: "queued",
      task: {
        externalRef: body.externalRef,
        title: body.title,
        goal: body.goal,
        ...(caseId ? { caseId } : {}),
        inputs: prepared.inputs,
        expectedOutputs: body.expectedOutputs,
        outputDir: body.outputDir,
        timeoutMs: body.timeoutMs ?? 180_000,
        maxSteps: resolved.config.maxSteps ?? 8,
        model: resolved.config.model
      },
      workspace: new DirectoryTaskWorkspace(outputDir),
      events: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: 0,
      artifacts: [],
      error: null,
      nextAction: null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      seq: 0
    };
    this.tasks.set(id, task);
    this.prune();
    const loop = new AgentLoop({
      provider: resolved.provider,
      task,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    const running = loop.run().catch((error) => {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.finishedAt = new Date().toISOString();
    });
    this.running.add(running);
    void running.finally(() => this.running.delete(running));
    return { task: { id, status: task.status }, created: true };
  }

  async getTask(taskId: string): Promise<AgentTaskView> {
    const task = this.tasks.get(taskId);
    if (!task) return { task: { id: taskId, status: "failed", error: { message: "任务不存在或已过期" } } };
    return {
      task: {
        id: task.id,
        status: task.status,
        nextAction: task.nextAction,
        error: task.error ? { message: task.error } : null,
        externalRef: task.task.externalRef,
        artifacts: task.artifacts.map((relativePath) => ({
          relativePath,
          mimeType: mimeFor(relativePath),
          bytes: 0
        }))
      },
      runs: [{
        attempt: 1,
        status: task.status,
        usage: { inputTokens: task.usage.inputTokens, outputTokens: task.usage.outputTokens }
      }],
      approvals: [],
      events: task.events.map((event) => ({
        seq: event.seq,
        type: event.type,
        payload: asRecord(event.payload) ?? { value: event.payload },
        createdAt: event.createdAt
      }))
    };
  }

  async getArtifacts(request: AgentArtifactRequest): Promise<ArtifactMap> {
    const task = this.tasks.get(request.taskId);
    const root = resolveRunOutputDir(this.options.repoRoot, this.options.artifactRoot, request.outputDir);
    const artifacts: ArtifactMap = {};
    const files = task ? task.artifacts.map(normalizeRelative) : listFiles(root);
    for (const relativePath of files) {
      const absolute = resolve(root, relativePath);
      if (!isPathInside(root, absolute) || !existsSync(absolute)) continue;
      const stats = statSync(absolute);
      if (!stats.isFile() || stats.size > 20 * 1024 * 1024) continue;
      const mimeType = mimeFor(relativePath);
      const text = mimeType.startsWith("text/") || mimeType === "application/json" ? readFileSync(absolute, "utf8") : "";
      artifacts[relativePath] = { text, bytes: stats.size, mimeType };
    }
    return artifacts;
  }

  async getTrace(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return buildEvalTrace(taskId, [], { taskStatus: "failed" });
    return buildEvalTrace(taskId, task.events as RawTraceEvent[], {});
  }

  async cancelTask(taskId: string): Promise<Record<string, unknown>> {
    const task = this.tasks.get(taskId);
    if (!task) return { taskId, cancelled: false };
    if (task.status === "queued" || task.status === "running") {
      task.status = "failed";
      task.error = "CANCELLED: 用户取消";
      task.finishedAt = new Date().toISOString();
    }
    return { taskId, cancelled: true, status: task.status };
  }

  async health(): Promise<Record<string, unknown>> {
    const providers = this.options.providers.list();
    return {
      status: "ok",
      engine: "native",
      now: new Date().toISOString(),
      providers: providers.length,
      chatModel: providers[0]
        ? { configured: providers[0].apiKeyHint !== null, settings: { model: providers[0].model } }
        : { configured: false }
    };
  }

  getNativeTask(taskId: string): NativeTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /** Wait for in-flight tasks (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private prune(): void {
    const limit = this.options.maxTasks ?? 200;
    if (this.tasks.size <= limit) return;
    for (const [id, task] of this.tasks) {
      if (task.status === "completed" || task.status === "failed") this.tasks.delete(id);
      if (this.tasks.size <= limit) break;
    }
  }
}

export function caseIdFromExternalRef(externalRef: string): string | null {
  // eval:<experimentId>:<caseId>:<executorId>:r<n>
  const parts = externalRef.split(":");
  return parts.length >= 5 && parts[0] === "eval" ? parts[2] ?? null : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asTaskError(error: unknown): Error {  if (error instanceof ProviderError) return new Error(`${error.code}: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string, prefix: string, depth: number): void => {
    if (depth > 8 || files.length >= 200) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), relative, depth + 1);
      else if (entry.isFile()) files.push(relative);
    }
  };
  visit(root, "", 0);
  return files;
}

function mimeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (/\.(txt|log|ya?ml|html?|css|js|ts|tsx)$/.test(lower)) return "text/plain";
  return "application/octet-stream";
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, "");
  const normalized = resolve(candidate);
  return normalized === normalizedRoot
    || normalized.startsWith(`${normalizedRoot}\\`)
    || normalized.startsWith(`${normalizedRoot}/`);
}
