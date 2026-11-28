// Read-only HTTP reader for the OS evidence plane.
//
// Hearth Eval never opens the OS SQLite database. Every runtime fact — manifest,
// exchange, provenance, policy decision, cost, replay report — is fetched from
// the versioned `/api/evidence/*`, `/api/replay/*` and `/api/cost/*` endpoints.
import type {
  ArtifactProvenance,
  DivergenceReport,
  RuntimeExchange,
  RuntimeManifest,
  VerificationResult,
  VerificationSpec
} from "@hearth/eval-core";

export class EvidenceClientError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "EvidenceClientError";
    this.code = code;
    this.status = status;
  }
}

export interface EvidenceClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface OsReplayResult {
  report: DivergenceReport;
  run: {
    id: string;
    status: string;
    finalResponse: string;
    usage: Record<string, unknown> | null;
    turns: number;
    toolCalls: number;
    failure: unknown;
  };
  workspace: string;
  forkRunId?: string;
}

export interface TaskCostView {
  taskId: string;
  statuses: Array<{ scopeKey: string; kind: string; spentUsd: number; limitUsd: number | null; decision: string; reason: string }>;
  budgets: Array<{ scopeKey: string; limitUsd: number; onExceed: string }>;
  entries: Array<{
    id: string;
    runId: string;
    taskId: string;
    usd: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    pricingSnapshotId: string | null;
    atDate: string;
  }>;
  degradations: Array<Record<string, unknown>>;
}

export class EvidenceClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: EvidenceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { "content-type": "application/json", ...(init.headers ?? {}) }
      });
      const text = await response.text();
      if (!response.ok) {
        throw new EvidenceClientError(
          text.includes("error") ? text.slice(0, 200) : "OS_REQUEST_FAILED",
          `Hearth OS ${response.status} ${path}: ${text.slice(0, 300)}`,
          response.status
        );
      }
      return text ? JSON.parse(text) as T : {} as T;
    } catch (error) {
      if (error instanceof EvidenceClientError) throw error;
      throw new EvidenceClientError("OS_UNREACHABLE", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("/api/evidence/health");
  }

  async manifest(runId: string): Promise<RuntimeManifest> {
    const response = await this.request<{ manifest: RuntimeManifest }>(`/api/evidence/runs/${encodeURIComponent(runId)}/manifest`);
    return response.manifest;
  }

  exchanges(runId: string): Promise<{ exchanges: RuntimeExchange[] }> {
    return this.request(`/api/evidence/runs/${encodeURIComponent(runId)}/exchanges`);
  }

  taskEvidence(taskId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/evidence/tasks/${encodeURIComponent(taskId)}/evidence`);
  }

  taskView(taskId: string): Promise<{
    task?: Record<string, unknown>;
    runs?: Array<Record<string, unknown>>;
    artifacts?: Array<Record<string, unknown>>;
  }> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  artifactGraph(taskId: string): Promise<{ nodes: unknown[]; edges: unknown[]; artifacts: unknown[] }> {
    return this.request(`/api/evidence/tasks/${encodeURIComponent(taskId)}/graph`);
  }

  provenance(artifactId: string): Promise<ArtifactProvenance> {
    return this.request(`/api/evidence/artifacts/${encodeURIComponent(artifactId)}/provenance`);
  }

  compare(leftRunId: string, rightRunId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/evidence/compare?left=${encodeURIComponent(leftRunId)}&right=${encodeURIComponent(rightRunId)}`);
  }

  policy(taskId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/evidence/policy/${encodeURIComponent(taskId)}`);
  }

  policyActual(taskId: string): Promise<Record<string, unknown>> {
    return this.request(`/api/evidence/policy/${encodeURIComponent(taskId)}/actual`);
  }

  preflight(input: { taskId: string; actions: Array<Record<string, unknown>>; policy?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.request("/api/evidence/policy/preflight", { method: "POST", body: JSON.stringify(input) });
  }

  verify(input: { spec: VerificationSpec; taskId?: string | null; runId?: string | null; workspaceRoot?: string }): Promise<{ result: VerificationResult; gate: Record<string, unknown> }> {
    return this.request("/api/evidence/verify", { method: "POST", body: JSON.stringify(input) });
  }

  replay(input: { cassetteId: string; mode?: "strict_replay" | "live_on_divergence"; replacement?: Record<string, unknown>; taskId?: string | null; timeoutMs?: number }): Promise<OsReplayResult> {
    return this.request("/api/replay/runs", { method: "POST", body: JSON.stringify(input) });
  }

  replayReport(id: string): Promise<{ report: DivergenceReport }> {
    return this.request(`/api/replay/reports/${encodeURIComponent(id)}`);
  }

  fork(input: {
    runId: string;
    checkpointSeq?: number;
    replacement?: Record<string, unknown>;
    label?: string;
    timeoutMs?: number;
  }): Promise<OsReplayResult & { forkRunId: string }> {
    return this.request(`/api/runs/${encodeURIComponent(input.runId)}/fork`, { method: "POST", body: JSON.stringify(input) });
  }

  cost(taskId: string): Promise<TaskCostView> {
    return this.request(`/api/cost/tasks/${encodeURIComponent(taskId)}`);
  }

  costSummary(): Promise<Record<string, unknown>> {
    return this.request("/api/cost/summary");
  }

  variants(): Promise<{ variants: unknown[] }> {
    return this.request("/api/evidence/variants");
  }

  variantMetrics(): Promise<Record<string, unknown>> {
    return this.request("/api/evidence/variants/metrics");
  }
}
