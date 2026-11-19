/**
 * Types for the native (in-repo) evaluation agent.
 *
 * An executor is one "LLM + settings" pair. Today only `openai-compatible`
 * providers are supported; more provider kinds are added by widening
 * `NativeProviderKind` and registering an adapter in the server.
 */

export const LLM_PROVIDER_KINDS = ["openai-compatible"] as const;
export type LLMProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

export interface LLMProviderConfig {
  id: string;
  /** Display name, also used as the evaluation executor name. */
  name: string;
  kind: LLMProviderKind;
  /** API root such as `https://api.deepseek.com/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  model: string;
  /** Kept server-side only; never returned by the API. */
  apiKey: string;
  maxSteps?: number;
  temperature?: number;
  /** Wire format for tool arguments. Most OpenAI-compatible servers use `string`. */
  toolArgumentFormat?: "string" | "object";
  /** Chat template flavour used to render the prompt. */
  promptStyle?: "chatml" | "harmony";
}

export interface NativeProviderView {
  id: string;
  name: string;
  kind: LLMProviderKind;
  baseUrl: string;
  model: string;
  /** Masked hint such as `sk-…3f2a`; null when no key is stored. */
  apiKeyHint: string | null;
  maxSteps: number;
  temperature: number | null;
  toolArgumentFormat: "string" | "object";
  promptStyle: "chatml" | "harmony";
}

export interface NativeProviderInput {
  id?: string;
  name: string;
  kind: LLMProviderKind;
  baseUrl?: string;
  model: string;
  apiKey?: string;
  maxSteps?: number;
  temperature?: number;
  clearApiKey?: boolean;
  toolArgumentFormat?: "string" | "object";
  promptStyle?: "chatml" | "harmony";
}

export interface NativeProviderTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  message: string;
  baseUrl: string;
}

export interface NativeToolCall extends Record<string, unknown> {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface NativeRunOptions {
  /** Eval case identifier; the native agent uses it to pick a task prompt. */
  caseId?: string;
  model?: string;
  maxSteps?: number;
  temperature?: number;
}

export interface NativeRunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
}

export interface NativeAgentRunResult {
  status: "completed" | "failed";
  /** Files written below the output directory, relative, POSIX separators. */
  artifacts: string[];
  usage: NativeRunUsage;
  error: string | null;
}

/** The seam every model backend has to satisfy. */
export interface ProviderAdapter {
  readonly kind: LLMProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  complete(messages: Array<Record<string, unknown>>, tools: unknown[]): Promise<unknown>;
  testConnection(): Promise<NativeProviderTestResult>;
}

/** The agent's only world: a directory it can list, read and write. */
export interface TaskWorkspace {
  list(relativePath?: string): string;
  read(relativePath: string): string;
  write(relativePath: string, content: string): void;
}

export interface NativeExecutorOption {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  canRun: boolean;
  version: string | null;
  issues: string[];
}
