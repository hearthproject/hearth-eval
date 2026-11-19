import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  LLMProviderConfig,
  LLMProviderKind,
  NativeProviderTestResult
} from "@hearth/eval-core";

export class ProviderError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: string, message: string, status: number | null = null, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

interface ChatCompletionMessage {
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: unknown };
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatCompletionMessage; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  model?: string;
  error?: { message?: string; type?: string; code?: string };
}

export type ProviderMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/**
 * Stateless adapter around an OpenAI-compatible `POST {baseUrl}/chat/completions`.
 *
 * Everything provider specific lives here: request shape, tool-call wire format,
 * and response/stream parsing. Adding another backend means adding another class
 * that satisfies this shape and registering it in `createProviderAdapter`.
 */
export class OpenAICompatibleProvider {
  readonly kind: LLMProviderKind = "openai-compatible";
  readonly model: string;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly toolArgumentFormat: "string" | "object";
  private readonly source: LLMProviderConfig;

  constructor(config: LLMProviderConfig, options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.source = config;
    this.model = config.model;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.toolArgumentFormat = config.toolArgumentFormat ?? "string";
  }

  get config(): LLMProviderConfig {
    return this.source;
  }

  /** One non-streaming turn. Returns the assistant message plus usage. */
  async chat(
    messages: ProviderMessage[],
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  ): Promise<{
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    usage: { inputTokens: number; outputTokens: number };
  }> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.encode(messages),
      temperature: 0.2
    };
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters }
      }));
      body.tool_choice = "auto";
    }
    const payload = await this.post("/chat/completions", body);
    const message = payload.choices?.[0]?.message;
    if (!message) throw new ProviderError("PROVIDER_BAD_RESPONSE", "模型返回缺少 choices[0].message");
    const toolCalls = (message.tool_calls ?? []).flatMap((call, index) => {
      const name = call.function?.name;
      if (typeof name !== "string" || name.length === 0) return [];
      return [{
        id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
        name,
        arguments: encodeArguments(call.function?.arguments)
      }];
    });
    return {
      content: typeof message.content === "string" ? message.content : "",
      toolCalls,
      usage: {
        inputTokens: Number(payload.usage?.prompt_tokens ?? 0),
        outputTokens: Number(payload.usage?.completion_tokens ?? 0)
      }
    };
  }

  async testConnection(): Promise<NativeProviderTestResult> {
    const startedAt = Date.now();
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        stream: false
      };
      const payload = await this.post("/chat/completions", body);
      return {
        ok: true,
        model: payload.model ?? this.model,
        latencyMs: Date.now() - startedAt,
        baseUrl: this.baseUrl,
        message: "连接成功"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, model: null, latencyMs: Date.now() - startedAt, baseUrl: this.baseUrl, message };
    }
  }

  private encode(messages: ProviderMessage[]): unknown[] {
    const encoded: unknown[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        encoded.push({ role: "user", content: message.content });
        continue;
      }
      if (message.role === "assistant") {
        const record: Record<string, unknown> = { role: "assistant", content: message.content };
        if (message.toolCalls && message.toolCalls.length > 0) {
          record.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: this.toolArgumentFormat === "object" ? safeParse(call.arguments) : call.arguments
            }
          }));
          if (record.content === "") record.content = null;
        }
        encoded.push(record);
        continue;
      }
      encoded.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    }
    return encoded;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<ChatCompletionResponse> {
    if (!this.apiKey) throw new ProviderError("PROVIDER_NO_KEY", "未配置 API Key");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      let payload: ChatCompletionResponse = {};
      try {
        payload = text ? (JSON.parse(text) as ChatCompletionResponse) : {};
      } catch {
        payload = { error: { message: text.slice(0, 500) } };
      }
      if (!response.ok) {
        const detail = payload.error?.message ?? `HTTP ${response.status}`;
        throw new ProviderError(
          `PROVIDER_HTTP_${response.status}`,
          `模型接口返回 ${response.status}：${detail}`,
          response.status,
          response.status === 408 || response.status === 429 || response.status >= 500
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ProviderError("PROVIDER_TIMEOUT", `模型请求超时（${this.timeoutMs}ms）`, null, true);
      }
      throw new ProviderError("PROVIDER_UNREACHABLE", error instanceof Error ? error.message : String(error), null, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

export type ChatProvider = Pick<OpenAICompatibleProvider, "kind" | "model" | "baseUrl" | "chat" | "testConnection"> & {
  /** Full config, used to clone the adapter onto a different transport. */
  readonly config: LLMProviderConfig;
};

/** Registry: the single switch that new provider kinds get added to later. */
export function createProviderAdapter(
  config: LLMProviderConfig,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): ChatProvider {
  switch (config.kind) {
    case "openai-compatible":
      return new OpenAICompatibleProvider(config, options);
    default:
      throw new ProviderError("PROVIDER_UNSUPPORTED", `暂不支持的模型协议：${String(config.kind)}`);
  }
}

/** Same adapter, different transport (tests, proxies). */
export function standinProvider(provider: ChatProvider, fetchImpl: typeof fetch): ChatProvider {
  const config = provider.config;
  return createProviderAdapter(config, { fetchImpl });
}

export class DirectoryTaskWorkspace {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  list(relativePath = "."): string {
    const directory = this.resolveInside(relativePath);
    if (!existsSync(directory)) return "(空目录)";
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) return "(空目录)";
    return entries
      .map((entry) => {
        if (entry.isDirectory()) return `${entry.name}/`;
        const size = statSync(join(directory, entry.name)).size;
        return `${entry.name} (${size} bytes)`;
      })
      .join("\n");
  }

  read(relativePath: string): string {
    const file = this.resolveInside(relativePath);
    if (!existsSync(file)) throw new ProviderError("WORKSPACE_NOT_FOUND", `文件不存在：${relativePath}`);
    const stats = statSync(file);
    if (!stats.isFile()) throw new ProviderError("WORKSPACE_NOT_FILE", `不是文件：${relativePath}`);
    if (stats.size > 512 * 1024) throw new ProviderError("WORKSPACE_TOO_LARGE", `文件过大：${relativePath}`);
    return readFileSync(file, "utf8");
  }

  write(relativePath: string, content: string): void {
    const file = this.resolveInside(relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }

  absolutePath(relativePath: string): string {
    return this.resolveInside(relativePath);
  }

  private resolveInside(relativePath: string): string {
    const candidate = resolve(this.root, relativePath);
    const inside = candidate === this.root || candidate.startsWith(`${this.root}\\`) || candidate.startsWith(`${this.root}/`);
    if (!inside) throw new ProviderError("WORKSPACE_PATH_DENIED", `不允许访问工作目录之外的路径：${relativePath}`);
    return candidate;
  }
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/chat/completions")) return trimmed.slice(0, -"/chat/completions".length);
  return trimmed;
}

function encodeArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
