import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerImportedEvaluationRoutes } from "./imported-evaluation.ts";
import { EvalStore } from "./store.ts";

const cli = fileURLToPath(new URL("../../../scripts/hearth-eval.mjs", import.meta.url));
const codexHook = fileURLToPath(new URL("../../../integrations/codex/stop.mjs", import.meta.url));
const codexPlugin = fileURLToPath(new URL("../../../integrations/codex/plugin/server.mjs", import.meta.url));

it("scores structured uploads and authenticated batches with identical frozen rules", async () => {
  const store = new EvalStore(":memory:");
  const app = Fastify();
  registerImportedEvaluationRoutes(app, store);
  const checks = [{ id: "draft", title: "未发送", blocker: true, config: { kind: "json", path: "output.txt", equals: { sent: false } } }];
  const task = { title: "草稿", prompt: "保存草稿", input: "", expectedOutput: "JSON", checks };
  const agents = [{ agent: "A", version: "1" }, { agent: "B", version: "1" }];
  try {
    const upload = await app.inject({ method: "POST", url: "/api/imported-evaluations", payload: { ...task,
      submissions: agents.map((agent, i) => ({ ...agent, fileName: "draft.json", text: JSON.stringify({ sent: i === 1 }) })) } });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().results).toMatchObject([{ score: 100, verdict: "pass", mode: "artifact_checks" }, { score: 0, verdict: "fail" }]);
    expect(upload.json().checks[0].weight).toBe(1);
    const batch = await app.inject({ method: "POST", url: "/api/imported-evaluations/batches", payload: { ...task, agents } });
    expect(batch.statusCode).toBe(201);
    const { evaluation, token } = batch.json();
    const submission = await app.inject({ method: "POST", url: `/api/imported-evaluations/${evaluation.id}/submissions`,
      headers: { authorization: `Bearer ${token}` }, payload: { slot: 1, runId: "test", fileName: "a.json", text: '{"sent":false}' } });
    expect(submission.statusCode).toBe(201);
    expect(submission.json().result).toEqual(upload.json().results[0]);
    expect((await app.inject({ method: "POST", url: "/api/imported-evaluations/batches", payload: { ...task, requiredText: ["sent"], agents } })).statusCode).toBe(400);
    expect((await app.inject("/api/evaluation/calibration")).json().summary.total).toBe(18);
  } finally { await app.close(); store.close(); }
});

it("rejects empty rule-generation input and requests from another origin before invoking Codex", async () => {
  const store = new EvalStore(":memory:");
  const app = Fastify();
  registerImportedEvaluationRoutes(app, store);
  try {
    const url = "/api/codex/generate-rules";
    expect((await app.inject({ method: "POST", url, payload: { description: " " } })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST", url, headers: { origin: "https://example.com" }, payload: { description: "测试" }
    })).statusCode).toBe(403);
  } finally {
    await app.close();
    store.close();
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv, input = ""): Promise<string> {
  return runScript(cli, args, input, { env: { ...process.env, ...env } });
}

function runScript(script: string, args: string[], input: string, options: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], options);
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(errors)));
    child.stdin.end(input);
  });
}

it("scores two imported deliverables against the same checks and saves their evidence", async () => {
  const store = new EvalStore(":memory:");
  const app = Fastify();
  registerImportedEvaluationRoutes(app, store);
  const url = "/api/imported-evaluations";
  const payload = {
    title: "访谈总结",
    prompt: "找出客户反馈",
    input: "客户反馈",
    expectedOutput: "一份 Markdown 报告",
    requiredText: ["onboarding", "导出"],
    submissions: [
      { agent: "A", version: "1", fileName: "report.md", text: "Onboarding 和导出" },
      { agent: "B", version: "2", fileName: "report.md", text: "需要导出功能" }
    ]
  };

  try {
    const invalid = await app.inject({ method: "POST", url, payload: { ...payload, submissions: payload.submissions.slice(1) } });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject(url)).json()).toEqual([]);

    const created = await app.inject({ method: "POST", url, payload });
    expect(created.statusCode).toBe(201);
    const evaluation = created.json();
    expect(evaluation.results.map((result: { score: number }) => result.score)).toEqual([100, 50]);
    expect(evaluation.results[0].checks[0].evidence).toEqual(["包含：onboarding"]);
    expect(evaluation.results[1].checks[0].reason).toContain("onboarding");
    expect((await app.inject(`${url}/${evaluation.id}`)).json()).toEqual(evaluation);
    expect((await app.inject(url)).json()).toEqual([
      { id: evaluation.id, title: payload.title, createdAt: evaluation.createdAt }
    ]);
    expect((await app.inject(`${url}/unknown`)).statusCode).toBe(404);
  } finally {
    await app.close();
    store.close();
  }
});

it("accepts independent authenticated CLI and Claude Stop submissions, with retry deduplication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-eval-hook-"));
  const store = new EvalStore(":memory:");
  const app = Fastify();
  registerImportedEvaluationRoutes(app, store);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const created = await app.inject({
      method: "POST",
      url: "/api/imported-evaluations/batches",
      payload: {
        title: "访谈总结", prompt: "整理反馈", input: "", expectedOutput: "报告",
        requiredText: ["导出", "搜索"],
        agents: [{ agent: "Claude Code", version: "" }, { agent: "Agent B", version: "2" }]
      }
    });
    expect(created.statusCode).toBe(201);
    const { evaluation, token } = created.json();
    const url = `/api/imported-evaluations/${evaluation.id}`;
    expect((await app.inject(url)).json()).not.toHaveProperty("token");
    const payload = { slot: 1, runId: "session-001", fileName: "a.md", text: "导出 和 搜索" };
    expect((await app.inject({ method: "POST", url: `${url}/submissions`, payload })).statusCode).toBe(401);
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    const metadataFile = join(dir, "b.json");
    await writeFile(a, payload.text);
    await writeFile(b, "导出");
    await writeFile(metadataFile, JSON.stringify({ outputTokens: 123, durationMs: 456, log: "完成" }));
    const env = { HEARTH_EVAL_ID: evaluation.id, HEARTH_EVAL_TOKEN: token, HEARTH_EVAL_URL: address };
    const hookEnv = { ...env, HEARTH_EVAL_SLOT: "1", HEARTH_EVAL_FILE: a };
    const hookInput = JSON.stringify({ hook_event_name: "Stop", session_id: payload.runId, stop_hook_active: false });
    const manual = ["submit", "--slot", "2", "--file", b, "--run-id", "other-001", "--metadata-file", metadataFile];

    const first = await runCli(manual, env);
    expect(JSON.parse(first)).toMatchObject({ duplicate: false, result: { score: 50 } });
    expect((await app.inject(url)).json().submissions).toMatchObject([
      { slot: 2, agent: "Agent B", metadata: { outputTokens: 123, durationMs: 456, log: "完成" } }
    ]);
    await runCli(["claude-stop"], hookEnv, hookInput);
    await runCli(["claude-stop"], hookEnv, hookInput);
    expect(JSON.parse(await runCli(manual, env))).toMatchObject({ duplicate: true });
    const final = (await app.inject(url)).json();
    expect(final.submissions).toMatchObject([{ slot: 2 }, { slot: 1, runId: "session-001" }]);
    expect(final.results.map((result: { score: number }) => result.score)).toEqual([50, 100]);
    const conflict = await app.inject({
      method: "POST", url: `${url}/submissions`, headers: { authorization: `Bearer ${token}` },
      payload: { ...payload, text: "不同版本" }
    });
    expect(conflict.statusCode).toBe(409);
  } finally {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

it("displays Codex scores and records their criteria and outcomes without storing the answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hearth-codex-hook-"));
  const store = new EvalStore(":memory:");
  const app = Fastify();
  registerImportedEvaluationRoutes(app, store);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const event = { hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "测试已完成" };
    const run = (payload: typeof event) => runScript(codexHook, [], JSON.stringify(payload), { cwd: dir });
    expect(await run(event)).toBe("");
    await mkdir(join(dir, ".hearth"));
    await writeFile(join(dir, ".hearth", "codex-eval.json"), JSON.stringify({
      requiredText: ["测试", "通过"], port: address.port
    }));
    expect(JSON.parse(await run(event))).toEqual({
      systemMessage: "Hearth 评分 50/100 · 文本检查通过 1/2"
    });
    await writeFile(join(dir, "codex-eval.json"), JSON.stringify({
      requiredText: ["测试"], port: address.port
    }));
    const rpc = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "score_turn", arguments: { cwd: dir, text: event.last_assistant_message, publish: true }
      } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: {
        name: "score_turn", arguments: { cwd: dir, text: event.last_assistant_message, publish: true, continued: true }
      } }
    ];
    const replies = (await runScript(codexPlugin, [], rpc.map((message) => JSON.stringify(message)).join("\n"), { cwd: dir }))
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(replies[0].result.serverInfo.name).toBe("hearth-eval");
    expect(replies[1].result.tools[0].name).toBe("score_turn");
    expect(replies[2].result.structuredContent).toMatchObject({
      decision: "block", reason: expect.stringContaining("Hearth 评分 100/100 · 文本检查通过 1/1")
    });
    expect(replies[3].result.structuredContent).toEqual({});
    expect(await run({ ...event, stop_hook_active: true })).toBe("");
    const history = (await app.inject("/api/codex/scores")).json();
    expect(history.records).toHaveLength(2);
    expect(history.records[0]).toMatchObject({
      score: 100,
      checks: [{ requiredText: "测试", passed: true }]
    });
    expect(history.records[1]).toMatchObject({
      score: 50,
      checks: [{ requiredText: "测试", passed: true }, { requiredText: "通过", passed: false }]
    });
    expect(JSON.stringify(history)).not.toContain(event.last_assistant_message);
    const older = (await app.inject(`/api/codex/scores?before=${history.records[0].id}`)).json();
    expect(older.records).toEqual([history.records[1]]);
    expect((await app.inject("/api/imported-evaluations")).json()).toEqual([]);
  } finally {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
