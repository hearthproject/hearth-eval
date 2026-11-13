import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { resolveRunOutputDir } from "./artifact-path.ts";
import type {
  ArtifactMap,
  EvalTaskRequest,
  JudgeRequest,
  JudgeResponse,
} from "@hearth/eval-core";
import type {
  AgentAdapter,
  AgentArtifactRequest,
  AgentTask,
  AgentTaskView,
} from "./agent-adapter.ts";

export type HearthTask = AgentTask;
export type HearthTaskView = AgentTaskView;
export { isTerminalTaskStatus, isWaitingTaskStatus } from "./agent-adapter.ts";

export class HearthClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly diagnostics: Record<string, unknown> | null;

  constructor(code: string, message: string, status: number | null = null, diagnostics: Record<string, unknown> | null = null) {
    super(message);
    this.name = "HearthClientError";
    this.code = code;
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

export interface HearthClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  artifactStorage?: { repoRoot: string; artifactRoot: string };
}

export class HearthClient implements AgentAdapter {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly artifactStorage: HearthClientOptions["artifactStorage"];

  constructor(options: HearthClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.artifactStorage = options.artifactStorage;
  }

  async createTask(
    body: EvalTaskRequest,
  ): Promise<{ task: HearthTask; created: boolean }> {
    return this.request("/api/eval/tasks", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getTask(taskId: string): Promise<HearthTaskView> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  //按照规则取出作业
  async getArtifacts({
    outputDir,
  }: AgentArtifactRequest): Promise<ArtifactMap> {
    if (!this.artifactStorage)
      throw new Error("Hearth 产物读取需要配置 artifactStorage");
    const root = resolveRunOutputDir(
      this.artifactStorage.repoRoot,
      this.artifactStorage.artifactRoot,
      outputDir,
    );
    if (!isPathInside(this.artifactStorage.artifactRoot, root))
      throw new Error(`评测产物目录越界：${outputDir}`);
    const artifacts: ArtifactMap = {};
    if (!existsSync(root)) return artifacts;
    walkArtifacts(root, root, artifacts, 0);
    return artifacts;
  }

  async judge(body: JudgeRequest): Promise<JudgeResponse> {
    return this.request("/api/eval/judge", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async cancelTask(taskId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }

  async system(): Promise<Record<string, unknown>> {
    return this.request("/api/system");
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request("/api/health");
  }

  async executors(): Promise<Record<string, unknown>> {
    return this.request("/api/executors");
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        payload = text;
      }
      if (!response.ok) {
        const record = asRecord(payload);
        throw new HearthClientError(
          typeof record?.error === "string"
            ? record.error
            : "HEARTH_HTTP_ERROR",
          typeof record?.message === "string"
            ? record.message
            : `Hearth 返回 HTTP ${response.status}`,
          response.status,
          asRecord(record?.diagnostics),
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof HearthClientError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new HearthClientError(
          "HEARTH_TIMEOUT",
          `请求 Hearth 超时：${path}`,
        );
      }
      throw new HearthClientError(
        "HEARTH_UNREACHABLE",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function walkArtifacts(
  root: string,
  directory: string,
  artifacts: ArtifactMap,
  depth: number,
): void {
  if (depth > 12 || Object.keys(artifacts).length >= 1_000) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkArtifacts(root, absolute, artifacts, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = statSync(absolute);
    if (stats.size > 20 * 1024 * 1024) continue;
    const relative = absolute.slice(root.length + 1).replace(/\\/g, "/");
    const mimeType = mimeFor(relative);
    const text = isTextMime(mimeType) ? readFileSync(absolute, "utf8") : "";
    artifacts[relative] = { text, bytes: stats.size, mimeType };
  }
}

function mimeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (
    [
      ".md",
      ".markdown",
      ".txt",
      ".html",
      ".htm",
      ".css",
      ".js",
      ".ts",
      ".json",
      ".csv",
      ".yaml",
      ".yml",
    ].includes(extension)
  ) {
    return extension === ".md" || extension === ".markdown"
      ? "text/markdown"
      : extension === ".json"
        ? "application/json"
        : "text/plain";
  }
  return "application/octet-stream";
}

function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, "");
  return (
    candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}\\`) ||
    candidate.startsWith(`${normalizedRoot}/`)
  );
}
