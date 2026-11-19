import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMProviderConfig } from "@hearth/eval-core";
import { AgentLoop, type NativeTask } from "./native-agent.ts";
import { DirectoryTaskWorkspace, OpenAICompatibleProvider } from "./providers.ts";
import { ProviderStore, maskKey } from "./provider-store.ts";
import { resolveNativeCase } from "./native-cases.ts";
import { CompositeAgentAdapter } from "./composite-adapter.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-native-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Scripted OpenAI-compatible endpoint: replays one assistant message per request. */
function fakeFetch(replies: unknown[], requests: Array<Record<string, unknown>> = []): typeof fetch {
  let index = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function config(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    id: "llm-test",
    name: "Test",
    kind: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    apiKey: "sk-test-key-123456",
    maxSteps: 4,
    ...overrides
  };
}

function task(workspace: DirectoryTaskWorkspace, expectedOutputs: string[]): NativeTask {
  const now = new Date().toISOString();
  return {
    id: "native-test",
    status: "queued",
    task: {
      externalRef: "eval:EXP:DOC-01:llm-test:r1",
      title: "DOC-01",
      goal: "生成 minutes.md",
      inputs: [{ kind: "file", label: "任务输入", value: "inputs/input.json" }],
      expectedOutputs,
      outputDir: "out",
      timeoutMs: 30_000,
      maxSteps: 4,
      model: "test-model"
    },
    workspace,
    events: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turns: 0,
    artifacts: [],
    error: null,
    nextAction: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    seq: 0
  };
}

describe("native agent loop", () => {
  it("writes expected artifacts through tool calls and records a trace", async () => {
    const dir = tempDir();
    const requests: Array<Record<string, unknown>> = [];
    const provider = new OpenAICompatibleProvider(config(), {
      fetchImpl: fakeFetch([
        {
          choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "minutes.md", content: "# 决策\n- 灰度" }) } }] } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 }
        },
        { choices: [{ message: { content: "完成" } }], usage: { prompt_tokens: 120, completion_tokens: 8 } }
      ], requests)
    });
    const workspace = new DirectoryTaskWorkspace(dir);
    const nativeTask = task(workspace, ["minutes.md"]);

    await new AgentLoop({ provider, task: nativeTask }).run();

    expect(nativeTask.status).toBe("completed");
    expect(nativeTask.artifacts).toEqual(["minutes.md"]);
    expect(readFileSync(join(dir, "minutes.md"), "utf8")).toContain("灰度");
    expect(nativeTask.usage).toEqual({ inputTokens: 220, outputTokens: 28, totalTokens: 248 });
    expect(nativeTask.events.map((event) => event.type)).toEqual([
      "run.started", "model.response", "artifact.written", "tool.call", "model.response", "run.completed"
    ]);
    expect(requests[0]?.model).toBe("test-model");
    expect((requests[1]?.messages as Array<Record<string, unknown>>)[2]).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("nudges the model when required outputs are missing, then fails on budget", async () => {
    const dir = tempDir();
    const provider = new OpenAICompatibleProvider(config(), {
      fetchImpl: fakeFetch([{ choices: [{ message: { content: "我完成了" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }])
    });
    const nativeTask = task(new DirectoryTaskWorkspace(dir), ["minutes.md"]);
    await new AgentLoop({ provider, task: nativeTask }).run();
    expect(nativeTask.status).toBe("failed");
    expect(nativeTask.error).toContain("MAX_STEPS");
    expect(nativeTask.turns).toBe(4);
  });

  it("denies reads and writes outside the workspace", async () => {
    const dir = tempDir();
    const workspace = new DirectoryTaskWorkspace(dir);
    expect(() => workspace.read("../../../etc/passwd")).toThrow(/工作目录之外/);
    expect(() => workspace.write("../escape.md", "x")).toThrow(/工作目录之外/);
  });

  it("surfaces provider HTTP errors as failed tasks", async () => {
    const dir = tempDir();
    const provider = new OpenAICompatibleProvider(config(), {
      fetchImpl: (async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })) as unknown as typeof fetch
    });
    const nativeTask = task(new DirectoryTaskWorkspace(dir), []);
    await new AgentLoop({ provider, task: nativeTask }).run();
    expect(nativeTask.status).toBe("failed");
    expect(nativeTask.error).toContain("PROVIDER_HTTP_401");
    expect(nativeTask.error).toContain("invalid api key");
  });
});

describe("provider store", () => {
  it("persists configs without leaking keys and masks the hint", () => {
    const dir = tempDir();
    const file = join(dir, "providers.json");
    const store = new ProviderStore({ file });
    const saved = store.save({ name: "DeepSeek", kind: "openai-compatible", model: "deepseek-chat", apiKey: "sk-abcdefghijklmnop" });
    expect(saved.apiKeyHint).toBe("sk-…mnop");
    expect(JSON.stringify(saved)).not.toContain("abcdefghijklmnop");
    expect(readFileSync(file, "utf8")).toContain("sk-abcdefghijklmnop");

    const reloaded = new ProviderStore({ file });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.resolve(saved.id).config.model).toBe("deepseek-chat");

    reloaded.save({ id: saved.id, name: "DeepSeek", kind: "openai-compatible", model: "deepseek-reasoner" });
    expect(reloaded.get(saved.id)?.apiKey).toBe("sk-abcdefghijklmnop");
    expect(reloaded.remove(saved.id)).toBe(true);
    expect(reloaded.list()).toHaveLength(0);
  });

  it("refuses to run a config without a key", () => {
    const store = new ProviderStore({ file: join(tempDir(), "providers.json") });
    const saved = store.save({ name: "x", kind: "openai-compatible", model: "m", apiKey: "k".repeat(20) });
    store.save({ id: saved.id, name: "x", kind: "openai-compatible", model: "m", clearApiKey: true });
    expect(() => store.resolve(saved.id)).toThrow(/缺少 API Key/);
    expect(maskKey(null)).toBeNull();
  });
});

describe("native case inputs", () => {
  it("copies an absolute case input into the workspace and rewrites the path", () => {
    const root = tempDir();
    const outputDir = ".hearth/eval-artifacts/EXP/DOC-01/llm-test/r1";
    const workspace = resolve(root, outputDir);
    const condition = join(root, "eval", "catalog", "v2", "cases", "DOC-01");
    mkdirSync(condition, { recursive: true });
    writeFileSync(join(condition, "input.json"), "{}", "utf8");
    // Exactly what the Hearth-shaped runner sends: an absolute path to the case input.
    const { inputs } = resolveNativeCase(root, "DOC-01", [
      { kind: "file", label: "任务输入", value: join(condition, "input.json") }
    ], outputDir);
    expect(inputs[0]?.value).toBe("inputs/input.json");
    expect(readFileSync(join(workspace, "inputs", "input.json"), "utf8")).toBe("{}");
  });

  it("copies a case directory into the workspace", () => {
    const root = tempDir();
    const outputDir = ".hearth/eval-artifacts/EXP/DOC-01/llm-test/r1";
    const condition = join(root, "eval", "catalog", "v2", "cases", "DOC-01");
    mkdirSync(condition, { recursive: true });
    writeFileSync(join(condition, "input.json"), "{}", "utf8");
    const { inputs } = resolveNativeCase(root, "DOC-01", [
      { kind: "file", label: "任务输入", value: condition }
    ], outputDir);
    expect(inputs[0]?.value).toBe("inputs/DOC-01");
    expect(readFileSync(join(resolve(root, outputDir), "inputs", "DOC-01", "input.json"), "utf8")).toBe("{}");
  });

  it("resolves a relative input against the case directory", () => {
    const root = tempDir();
    const outputDir = ".hearth/eval-artifacts/EXP/DOC-01/llm-test/r1";
    const condition = join(root, "eval", "catalog", "v2", "cases", "DOC-01");
    mkdirSync(condition, { recursive: true });
    writeFileSync(join(condition, "input.json"), "{\"title\":\"t\"}", "utf8");
    const { inputs } = resolveNativeCase(root, "DOC-01", [
      { kind: "file", label: "任务输入", value: "input.json" }
    ], outputDir);
    expect(inputs[0]?.value).toBe("inputs/input.json");
    expect(readFileSync(join(resolve(root, outputDir), "inputs", "input.json"), "utf8")).toContain("title");
  });
});

describe("composite adapter", () => {
  it("routes provider executor ids to the native adapter", async () => {
    const primary = {
      baseUrl: "http://hearth",
      createTask: async () => ({ task: { id: "hearth-task", status: "running" }, created: true }),
      getTask: async (id: string) => ({ task: { id, status: "running" } }),
      getArtifacts: async () => ({}),
      cancelTask: async () => ({}),
      health: async () => ({ status: "ok" })
    };
    const native = {
      baseUrl: "native://local",
      createTask: async () => ({ task: { id: "native-1", status: "running" }, created: true }),
      getTask: async (id: string) => ({ task: { id, status: "completed" } }),
      getArtifacts: async () => ({}),
      cancelTask: async () => ({}),
      health: async () => ({ status: "ok", engine: "native" }),
      executorOptions: () => [{ id: "llm-abc" }]
    };
    const composite = new CompositeAgentAdapter({ primary, native });
    expect((await composite.createTask({ externalRef: "e", title: "t", goal: "g", inputs: [], expectedOutputs: [], runMode: "offline", outputDir: "o", executorId: "llm-abc" })).task.id).toBe("native-1");
    expect((await composite.createTask({ externalRef: "e", title: "t", goal: "g", inputs: [], expectedOutputs: [], runMode: "offline", outputDir: "o", executorId: "codex" })).task.id).toBe("hearth-task");
    expect((await composite.getTask("native-9")).task.status).toBe("completed");
  });
});
