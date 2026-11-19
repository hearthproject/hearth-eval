import type { ChatProvider, ProviderMessage } from "./providers.ts";
import { DirectoryTaskWorkspace, ProviderError, standinProvider } from "./providers.ts";
import type { RawTraceEvent } from "@hearth/eval-core";

export interface NativeTaskRequest {
  externalRef: string;
  title: string;
  goal: string;
  caseId?: string;
  inputs: Array<{ kind: "file" | "url"; label: string; value: string }>;
  expectedOutputs: string[];
  outputDir: string;
  timeoutMs: number;
  maxSteps: number;
  model: string;
}

export type NativeTaskStatus = "queued" | "running" | "completed" | "failed";

export interface NativeTask {
  id: string;
  status: NativeTaskStatus;
  task: NativeTaskRequest;
  workspace: DirectoryTaskWorkspace;
  events: RawTraceEvent[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  turns: number;
  artifacts: string[];
  error: string | null;
  nextAction: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  seq: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "list_files",
    description: "列出工作目录中的文件。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对目录，默认 ." } },
      additionalProperties: false
    }
  },
  {
    name: "read_file",
    description: "读取工作目录中的文本文件。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对文件路径" } },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "write_file",
    description: "在工作目录中写入文本文件，覆盖同名文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对文件路径，例如 minutes.md" },
        content: { type: "string", description: "完整文件内容" }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  }
];

/** ReAct-style loop: model -> tool calls -> observation, bounded by maxSteps. */
export class AgentLoop {
  private readonly provider: ChatProvider;
  private readonly task: NativeTask;
  private readonly now: () => Date;
  private readonly maxSteps: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private cachedStandin: ChatProvider | null = null;

  constructor(options: { provider: ChatProvider; task: NativeTask; now?: () => Date; fetchImpl?: typeof fetch }) {
    this.provider = options.provider;
    this.task = options.task;
    this.now = options.now ?? (() => new Date());
    this.maxSteps = Math.max(1, Math.min(40, options.task.task.maxSteps));
    this.fetchImpl = options.fetchImpl;
  }

  async run(): Promise<void> {
    const request = this.task.task;
    const messages: ProviderMessage[] = [{ role: "user", content: renderPrompt(request) }];
    this.task.status = "running";
    this.task.startedAt = this.now().toISOString();
    this.emit("run.started", { model: request.model, maxSteps: this.maxSteps });
    const deadline = Date.now() + request.timeoutMs;

    for (let turn = 1; turn <= this.maxSteps; turn += 1) {
      if (Date.now() > deadline) {
        this.fail(`TASK_TIMEOUT: 超过 ${request.timeoutMs}ms 预算`);
        this.emit("run.timed-out", { turn, timeoutMs: request.timeoutMs });
        return;
      }
      this.task.turns = turn;
      let reply: Awaited<ReturnType<ChatProvider["chat"]>>;
      try {
        reply = await this.send(messages);
      } catch (error) {
        const detail = error instanceof ProviderError ? `${error.code}: ${error.message}` : String(error);
        this.fail(`MODEL_ERROR: ${detail}`);
        this.emit("model.error", { turn, error: detail });
        return;
      }
      this.task.usage.inputTokens += reply.usage.inputTokens;
      this.task.usage.outputTokens += reply.usage.outputTokens;
      this.task.usage.totalTokens = this.task.usage.inputTokens + this.task.usage.outputTokens;
      this.emit("model.response", {
        turn,
        content: truncate(reply.content, 4_000),
        toolCalls: reply.toolCalls.map((call) => call.name),
        usage: reply.usage
      });

      if (reply.toolCalls.length === 0) {
        const missing = request.expectedOutputs.filter((path) => !this.task.artifacts.includes(normalizeRelative(path)));
        if (missing.length === 0) {
          this.complete();
          return;
        }
        this.emit("run.missing-artifacts", { missing });
        messages.push({ role: "assistant", content: reply.content });
        messages.push({
          role: "user",
          content: `缺少必需产物：${missing.join(", ")}。请使用 write_file 写出这些文件，然后再结束。`
        });
        continue;
      }

      messages.push({
        role: "assistant",
        content: reply.content,
        toolCalls: reply.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments as unknown as string }))
      });
      for (const call of reply.toolCalls) {
        const observation = this.invoke(call.name, safeParse(call.arguments));
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: observation });
      }
    }
    this.fail("MAX_STEPS: 步数预算耗尽");
    this.emit("run.max-steps", { maxSteps: this.maxSteps });
  }

  private async send(messages: ProviderMessage[]): Promise<Awaited<ReturnType<ChatProvider["chat"]>>> {
    if (!this.fetchImpl) return this.provider.chat(messages, TOOLS);
    this.cachedStandin ??= standinProvider(this.provider, this.fetchImpl);
    return this.cachedStandin.chat(messages, TOOLS);
  }

  private invoke(name: string, args: Record<string, unknown>): string {
    try {
      if (name === "list_files") {
        const result = this.task.workspace.list(typeof args.path === "string" ? args.path : ".");
        this.emit("tool.call", { tool: name, path: args.path ?? ".", ok: true });
        return result;
      }
      if (name === "read_file") {
        const path = requireString(args, "path");
        const result = truncate(this.task.workspace.read(path), 60_000);
        this.emit("tool.call", { tool: name, path, ok: true, bytes: result.length });
        return result;
      }
      if (name === "write_file") {
        const path = normalizeRelative(requireString(args, "path"));
        const content = requireString(args, "content");
        this.task.workspace.write(path, content);
        if (!this.task.artifacts.includes(path)) this.task.artifacts.push(path);
        this.emit("artifact.written", { path, bytes: Buffer.byteLength(content, "utf8") });
        this.emit("tool.call", { tool: name, path, ok: true, bytes: content.length });
        return `已写入 ${path}（${content.length} 字符）`;
      }
      this.emit("tool.error", { tool: name, error: `未知工具：${name}` });
      return `未知工具：${name}。可用工具：${TOOLS.map((tool) => tool.name).join(", ")}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("tool.error", { tool: name, error: message });
      return `工具执行失败：${message}`;
    }
  }

  private complete(): void {
    this.task.status = "completed";
    this.task.finishedAt = this.now().toISOString();
    this.emit("run.completed", { artifacts: this.task.artifacts, turns: this.task.turns, usage: this.task.usage });
  }

  private fail(error: string): void {
    this.task.status = "failed";
    this.task.error = error;
    this.task.finishedAt = this.now().toISOString();
    this.emit("run.failed", { error, turns: this.task.turns, usage: this.task.usage });
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    this.task.seq += 1;
    this.task.events.push({ seq: this.task.seq, type, payload, createdAt: this.now().toISOString() });
  }
}

export function renderPrompt(request: NativeTaskRequest): string {
  const lines = [
    "你是一个在受控工作目录里完成文档/资料加工任务的助手。",
    "你可以使用 list_files、read_file、write_file 三个工具；只能访问工作目录内的文件。",
    `任务标题：${request.title}`,
    `任务目标：${request.goal}`,
    "输入材料："
  ];
  for (const input of request.inputs) {
    lines.push(`- [${input.label}] ${input.kind}: ${input.value}`);
  }
  lines.push(`必须产出的文件：${request.expectedOutputs.join(", ")}`);
  lines.push("完成全部必需文件后，不要再调用工具，直接给出简短结束说明。");
  return lines.join("\n");
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new ProviderError("TOOL_BAD_ARGUMENT", `缺少参数 ${key}`);
  return value;
}

export function normalizeRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…（已截断）` : value;
}
