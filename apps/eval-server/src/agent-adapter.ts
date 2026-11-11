import type {
  ArtifactMap,
  EvalTaskRequest,
  JudgeRequest,
  JudgeResponse,
} from "@hearth/eval-core";

/** Adapters translate provider-specific task states into the states consumed by EvalRunner. */
export interface AgentTask {
  id: string;
  status: string;
  nextAction?: string | null;
  error?: { message?: string } | null;
  externalRef?: string | null;
  artifacts?: Array<{ relativePath: string; mimeType: string; bytes: number }>;
  runs?: Array<{
    attempt: number;
    status: string;
    usage?: { inputTokens?: number; outputTokens?: number } | null;
  }>;
  approvals?: unknown[];
  [key: string]: unknown;
}

export interface AgentTaskView {
  task: AgentTask;
  artifacts?: Array<{
    relativePath: string;
    absolutePath: string;
    mimeType: string;
    bytes: number;
  }>;
  runs?: Array<{
    attempt: number;
    status: string;
    usage?: { inputTokens?: number; outputTokens?: number } | null;
  }>;
  approvals?: unknown[];
  events?: unknown[];
}

//adapter的统一规则
export interface AgentArtifactRequest {
  taskId: string;
  outputDir: string;
}

/** Runner boundary. Adapters provide artifacts keyed by relative output path. */
export interface AgentAdapter {
  readonly baseUrl: string;
  createTask(
    body: EvalTaskRequest,
  ): Promise<{ task: AgentTask; created: boolean }>;
  getTask(taskId: string): Promise<AgentTaskView>;
  getArtifacts(request: AgentArtifactRequest): Promise<ArtifactMap>;
  cancelTask(taskId: string): Promise<Record<string, unknown>>;
  health(): Promise<Record<string, unknown>>;
  judge(body: JudgeRequest): Promise<JudgeResponse>;
}

export function isTerminalTaskStatus(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

export function isWaitingTaskStatus(status: string): boolean {
  return [
    "waiting_input",
    "waiting_approval",
    "recoverable",
    "queued",
  ].includes(status);
}
