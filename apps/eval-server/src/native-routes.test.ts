import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvalApp } from "./app.ts";
import { EvalRunner } from "./runner.ts";
import { EvalStore } from "./store.ts";
import { NativeAgentClient } from "./native-client.ts";
import { ProviderStore } from "./provider-store.ts";
import { CompositeAgentAdapter } from "./composite-adapter.ts";
import { loadCaseCatalog } from "@hearth/eval-core/node";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const caseRoot = join(repoRoot, "eval", "catalog", "v2", "cases", "DOC-01");
const inputPath = join(caseRoot, "input.json");
const goldenPath = join(caseRoot, "golden", "minutes.md");
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function fakeFetch(replies: unknown[]): typeof fetch {
  let index = 0;
  return (async () => {
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("native console", () => {
  it("saves a provider without echoing the key and runs a case end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-native-api-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    // The runner resolves case inputs against `<repoRoot>/eval`, so stage one case there.
    mkdirSync(join(root, "eval", "catalog", "v2", "cases", "DOC-01", "golden"), { recursive: true });
    copyFileSync(join(caseRoot, "case.json"), join(root, "eval", "catalog", "v2", "cases", "DOC-01", "case.json"));
    copyFileSync(inputPath, join(root, "eval", "catalog", "v2", "cases", "DOC-01", "input.json"));
    copyFileSync(goldenPath, join(root, "eval", "catalog", "v2", "cases", "DOC-01", "golden", "minutes.md"));
    const store = new EvalStore(":memory:");
    cleanup.push(() => store.close());

    const loaded = loadCaseCatalog(root, join(root, "eval", "catalog", "v2", "cases"));
    const target = loaded.cases.find((item) => item.manifest.id === "DOC-01");
    expect(target).toBeDefined();
    const catalog = new Map([[target!.manifest.id, target!]]);
    store.syncCases(loaded.cases);

    const providers = new ProviderStore({ file: join(root, "providers.json") });
    const artifactRoot = join(root, "artifacts");
    const heardClient = {
      baseUrl: "http://hearth",
      createTask: async () => ({ task: { id: "hearth", status: "queued" }, created: true }),
      getTask: async (id: string) => ({ task: { id, status: "running" } }),
      getArtifacts: async () => ({}),
      cancelTask: async () => ({}),
      health: async () => ({ status: "offline" })
    };
    const nativeClient = new NativeAgentClient({ repoRoot: root, artifactRoot, providers, fetchImpl: fakeFetch([
      {
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "c1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "minutes.md", content: "# 决策\n- 灰度 10%（2026-11-19 王敏）\n# 行动项\n- 李哲 2026-11-20 安全评审\n- 慢查询监控" })
              }
            }]
          }
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      },
      { choices: [{ message: { content: "完成" } }], usage: { prompt_tokens: 12, completion_tokens: 2 } }
    ]) });
    const client = new CompositeAgentAdapter({ primary: heardClient, native: nativeClient });
    const runner = new EvalRunner({
      store,
      client,
      catalog,
      repoRoot: root,
      evalVersion: "test",
      artifactRoot,
      pollIntervalMs: 10
    });

    const app = await buildEvalApp({
      store,
      runner,
      client,
      providers,
      nativeClient,
      catalog,
      catalogIssues: 0,
      repoRoot: root,
      artifactRoot,
      dataDir: join(root, "data"),
      evalVersion: "test"
    });
    cleanup.push(() => void app.close());

    const created = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "DeepSeek", kind: "openai-compatible", model: "deepseek-chat", apiKey: "sk-secret-key-0001" }
    });
    expect(created.statusCode).toBe(201);
    const provider = created.json<{ id: string; apiKeyHint: string }>();
    expect(provider.apiKeyHint).toBe("sk-…0001");
    expect(created.body).not.toContain("sk-secret-key-0001");
    expect(readFileSync(join(root, "providers.json"), "utf8")).toContain("sk-secret-key-0001");

    const cases = await app.inject({ method: "GET", url: "/api/native/cases" });
    expect(cases.json<{ cases: Array<{ caseKey: string }> }>().cases.map((item) => item.caseKey)).toEqual(["DOC-01"]);

    const result = await app.inject({ method: "POST", url: "/api/native/run", payload: { caseId: "DOC-01", providerId: provider.id } });
    expect(result.statusCode).toBe(200);
    const body = result.json<{
      run: { id: string; status: string; score: number | null; error: string | null };
      graders: Array<{ criterionId: string; passed: boolean | null; reason: string }>;
      trace: { events: Array<{ type: string }> } | null;
      usage: { inputTokens: number; outputTokens: number };
    }>();
    // Text grader passes; the trajectory gate depends on the recorded trace.
    const exists = body.graders.find((grader) => grader.criterionId === "exists");
    expect(exists?.passed).toBe(true);
    const substance = body.graders.find((grader) => grader.criterionId === "substance");
    expect(substance?.passed).toBe(false);
    expect(body.trace?.events.some((event) => event.type === "artifact.written")).toBe(true);
    expect(body.usage.inputTokens).toBe(22);
    expect(body.run.error ?? "").toContain("BLOCKER_FAILED");

    const detail = await app.inject({ method: "GET", url: `/api/native/runs/${body.run.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ hearthTask: { turns: number } }>().hearthTask.turns).toBe(2);

    const runs = await app.inject({ method: "GET", url: "/api/native/runs" });
    expect(runs.json<{ experiments: unknown[] }>().experiments).toHaveLength(1);

    const missing = await app.inject({ method: "POST", url: "/api/native/run", payload: { caseId: "DOC-01", providerId: "nope" } });
    expect(missing.statusCode).toBe(400);
  });
});
