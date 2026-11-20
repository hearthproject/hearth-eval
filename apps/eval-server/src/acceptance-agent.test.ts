import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { AcceptanceInput, AcceptanceJob } from "@hearth/eval-core";
import { AcceptanceAgent, verifyMarkdown } from "./acceptance-agent.ts";
import { HearthAcceptanceExecutor, type AcceptanceExecutor } from "./acceptance-executor.ts";
import { registerAcceptanceRoutes } from "./acceptance-routes.ts";
import { EvalStore } from "./store.ts";
import { deliverArtifact } from "./acceptance-delivery.ts";
import type { JudgeAdapter } from "./judge-adapter.ts";
import { reviewAcceptance } from "./acceptance-review.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function harness(options: { contents?: Array<string | null>; status?: string; timeoutMs?: number; judge?: JudgeAdapter } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hearth-acceptance-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const desktop = join(root, "Desktop"); mkdirSync(desktop);
  const store = new EvalStore(join(root, "eval.sqlite")); cleanup.push(() => store.close());
  const tasks = new Map<string, AcceptanceJob>(); let count = 0;
  const executor: AcceptanceExecutor = {
    baseUrl: "http://127.0.0.1:4317",
    create: vi.fn(async (job: AcceptanceJob) => {
      count++; const id = `task-${count}`; tasks.set(id, job);
      const content = options.contents?.[count - 1];
      if (typeof content === "string") writeFileSync(job.targetPath, content);
      return { id };
    }),
    inspect: vi.fn(async () => ({ status: options.status ?? "completed" })),
    cancel: vi.fn(async () => {})
  };
  const agent = new AcceptanceAgent({ store, executor, desktopRoot: () => desktop, pollMs: 1, ...(options.judge ? { judge: options.judge } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  cleanup.push(() => agent.close());
  const input: AcceptanceInput = { requestId: randomUUID(), fileName: "delivery.md", title: "验收示例", requiredText: ["真实文件", "完成"], maxRepairs: 1 };
  return { agent, store, executor, desktop, input };
}
const good = "# 验收示例\n\n真实文件已经完成。\n";
const judgment = (passed: boolean) => ({ model: "test-judge", promptHash: "prompt-hash", overallConfidence: 0.9, usage: { inputTokens: 1, outputTokens: 1 },
  criteria: ["accuracy", "completeness", "clarity"].map(id => ({ id, passed: id === "accuracy" ? passed : true, confidence: 0.9, reason: passed || id !== "accuracy" ? "符合要求" : "把规划中的功能写成了已上线，需要纠正", evidence: ["真实文件已经完成。"] })) });

it("freezes shared memory for execution and semantic repair, and exposes outcomes without rewriting facts", async () => {
  const judge = { judge: vi.fn<JudgeAdapter["judge"]>().mockResolvedValueOnce(judgment(false)).mockResolvedValueOnce(judgment(true)) };
  const h = harness({ contents: [good, good], judge });
  h.agent.saveMemory("project", { content: "网页验收尚未实现。", expectedRevision: 0 });
  const input = { ...h.input, memoryKey: "project", memoryRevision: 1, semanticRequirements: "准确介绍已有与规划功能" };
  const job = h.agent.start(input);
  h.agent.saveMemory("project", { content: "新版本的背景资料。", expectedRevision: 1 });
  await h.agent.idle(job.id);
  const result = h.agent.get(job.id);
  expect(result.status).toBe("passed"); expect(result.attempts).toHaveLength(2);
  expect(result.contextSnapshot?.content).toBe("网页验收尚未实现。");
  expect(result.attempts[1]?.feedback).toContain("规划中的功能");
  for (const [request] of judge.judge.mock.calls) expect(request.artifacts["context.json"]?.text).toContain("网页验收尚未实现。");
  expect(h.agent.memory("project").memory?.revision).toBe(2);
  expect(h.agent.memory("project").outcomes).toMatchObject([{ jobId: job.id, status: "passed", revision: 1 }]);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "task" })));
  await new HearthAcceptanceExecutor("http://127.0.0.1:4317", fetchImpl).create(result, null);
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  expect(body.goal).toContain(result.contextSnapshot!.sha256); expect(body.goal).toContain("网页验收尚未实现。");
  expect(body.goal).not.toContain("新版本的背景资料。");
});

it("keeps memory versions consistent and persists them across database reopen", () => {
  const h = harness();
  expect(() => h.agent.start({ ...h.input, memoryKey: "missing", memoryRevision: 1, semanticRequirements: "介绍" })).toThrow("共享记忆");
  h.agent.saveMemory("project", { content: "事实", expectedRevision: 0 });
  expect(() => h.agent.saveMemory("project", { content: "过时的修改", expectedRevision: 0 })).toThrow("已变化");
  expect(() => h.agent.saveMemory("../escape", { content: "事实", expectedRevision: 0 })).toThrow();
  expect(() => h.agent.start({ ...h.input, memoryKey: "project", memoryRevision: 2, semanticRequirements: "介绍" })).toThrow("版本");
  const reopened = new EvalStore(join(h.desktop, "..", "eval.sqlite"));
  try { expect(reopened.getSharedMemory("project")?.content).toBe("事实"); } finally { reopened.close(); }
  expect(h.executor.create).not.toHaveBeenCalled();
});

it("does not bypass a failed semantic call on resume and does not rerun the executor", async () => {
  const judge = { judge: vi.fn<JudgeAdapter["judge"]>().mockRejectedValueOnce(new Error("judge unavailable")).mockResolvedValueOnce(judgment(true)) };
  const h = harness({ contents: [good], judge });
  h.agent.saveMemory("project", { content: "背景事实", expectedRevision: 0 });
  const job = h.agent.start({ ...h.input, memoryKey: "project", memoryRevision: 1, semanticRequirements: "准确介绍" });
  await h.agent.idle(job.id);
  expect(h.agent.get(job.id)).toMatchObject({ status: "error", attempts: [{ evidence: null }] });
  expect(h.agent.memory("project").outcomes).toEqual([]);
  h.agent.resume(job.id); await h.agent.idle(job.id);
  expect(h.agent.get(job.id).status).toBe("passed"); expect(h.executor.create).toHaveBeenCalledTimes(1);
  expect(judge.judge).toHaveBeenCalledTimes(2);
});

it("rejects fabricated semantic evidence and detects file changes during judging", async () => {
  const judge = { judge: vi.fn<JudgeAdapter["judge"]>().mockResolvedValue({ ...judgment(true), criteria: judgment(true).criteria.map(item => ({ ...item, evidence: ["invented quote"] })) }) };
  const h = harness({ contents: [good], judge });
  h.agent.saveMemory("project", { content: "背景事实", expectedRevision: 0 });
  const job = h.agent.start({ ...h.input, memoryKey: "project", memoryRevision: 1, semanticRequirements: "准确介绍" }); await h.agent.idle(job.id);
  expect(h.agent.get(job.id).error).toContain("不存在的证据");
  judge.judge.mockImplementationOnce(async () => { writeFileSync(job.targetPath, "external edit"); return judgment(true); });
  h.agent.resume(job.id); await h.agent.idle(job.id);
  expect(h.agent.get(job.id).error).toContain("文件已变化");
  expect(h.agent.memory("project").outcomes).toEqual([]);
});

it("does not approve missing semantic criteria or low confidence", async () => {
  const h = harness({ contents: [good] }); const job = h.agent.start(h.input); await h.agent.idle(job.id);
  job.contextSnapshot = { ...h.agent.saveMemory("project", { content: "事实", expectedRevision: 0 }), capturedAt: new Date().toISOString() };
  job.input.semanticRequirements = "准确介绍";
  const judge = { judge: vi.fn<JudgeAdapter["judge"]>().mockResolvedValueOnce({ ...judgment(true), criteria: [] }).mockResolvedValueOnce({ ...judgment(true), overallConfidence: 0.2 }) };
  await expect(reviewAcceptance(judge, job, good, "hash")).rejects.toThrow();
  await expect(reviewAcceptance(judge, job, good, "hash")).rejects.toThrow("置信度");
});

it("shares memory through local API with revision checks and rejects remote writes", async () => {
  const h = harness(); const app = Fastify(); cleanup.push(() => app.close());
  await registerAcceptanceRoutes(app, h.agent, h.executor.baseUrl);
  const url = "/api/acceptance/memory/project", payload = { content: "项目事实", expectedRevision: 0 };
  expect((await app.inject({ method: "PUT", url, payload, remoteAddress: "10.1.1.1" })).statusCode).toBe(403);
  expect((await app.inject({ method: "PUT", url, payload, headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
  expect((await app.inject({ method: "PUT", url, payload })).json()).toMatchObject({ revision: 1, content: "项目事实" });
  expect((await app.inject({ method: "PUT", url, payload })).statusCode).toBe(400);
  expect((await app.inject(url)).json()).toMatchObject({ memory: { revision: 1 }, outcomes: [] });
});

it("rejects semantic task submission before execution when no judge is configured", async () => {
  const h = harness(); const app = Fastify(); cleanup.push(() => app.close());
  h.agent.saveMemory("project", { content: "背景", expectedRevision: 0 });
  await registerAcceptanceRoutes(app, h.agent, h.executor.baseUrl);
  const result = await app.inject({ method: "POST", url: "/api/acceptance", payload: { ...h.input, memoryKey: "project", memoryRevision: 1, semanticRequirements: "介绍" } });
  expect(result.statusCode).toBe(400); expect(result.json().message).toContain("模型评委");
  expect(h.executor.create).not.toHaveBeenCalled();
});
const artifact = (text: string) => ({ artifactId: randomUUID(), bytes: Buffer.from(text), sha256: createHash("sha256").update(text).digest("hex") });

it("delivers published bytes unchanged, checks them independently and delivers a repaired artifact", async () => {
  const h = harness();
  const first = artifact("# 错误\n"), second = artifact(good);
  h.executor.artifact = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const job = h.agent.start(h.input); await h.agent.idle(job.id);
  const result = h.agent.get(job.id);
  expect(result.status).toBe("passed"); expect(result.attempts).toHaveLength(2);
  expect(result.attempts[0]?.evidence?.sha256).toBe(first.sha256);
  expect(result.attempts[1]?.delivery).toMatchObject({ artifactId: second.artifactId, sha256: second.sha256 });
  expect(readFileSync(result.targetPath)).toEqual(second.bytes);
});

it("refuses delivery over an externally created or changed file, and over hard links", async () => {
  const h = harness({ status: "running" }); const job = h.agent.start(h.input); await h.agent.close();
  const first = artifact("initial"), next = artifact(good);
  deliverArtifact(job, first, null, null);
  expect(() => deliverArtifact(job, next, null, null)).toThrow("外部修改或新增");
  writeFileSync(job.targetPath, "personal change");
  expect(() => deliverArtifact(job, next, first.sha256, null)).toThrow("外部修改或新增");
  expect(readFileSync(job.targetPath, "utf8")).toBe("personal change");
  linkSync(job.targetPath, join(h.desktop, "alias.md"));
  expect(() => deliverArtifact(job, next, first.sha256, null)).toThrow("普通文件");
});

it("supports delivery recovery only for the exact previously recorded source bytes", async () => {
  const h = harness({ status: "running" }); const job = h.agent.start(h.input); await h.agent.close();
  const source = artifact(good); deliverArtifact(job, source, null, null);
  expect(() => deliverArtifact(job, source, null, source.sha256)).not.toThrow();
  expect(() => deliverArtifact(job, artifact("different"), null, source.sha256)).toThrow();
});

it("downloads only the current run's named artifact and rejects corrupt published bytes", async () => {
  const source = artifact(good);
  const fetchImpl = vi.fn<typeof fetch>(async url => String(url).endsWith(`/artifacts/${source.artifactId}`)
    ? new Response(source.bytes)
    : new Response(JSON.stringify({ task: { currentRunId: "run-current" }, artifacts: [
      { id: "stale", taskId: "task", runId: "old", relativePath: "delivery.md" },
      { id: source.artifactId, taskId: "task", runId: "run-current", relativePath: "delivery.md", sha256: source.sha256, bytes: source.bytes.length }
    ] })));
  const executor = new HearthAcceptanceExecutor("http://127.0.0.1:4317", fetchImpl);
  await expect(executor.artifact("task", "delivery.md")).resolves.toEqual(source);
  fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ task: { currentRunId: "run-current" }, artifacts: [
    { id: source.artifactId, taskId: "task", runId: "run-current", relativePath: "delivery.md", sha256: "wrong", bytes: source.bytes.length }
  ] })));
  await expect(executor.artifact("task", "delivery.md")).rejects.toThrow("哈希");
});

it("does not accept completed prose without a file, sends failure evidence and rechecks repaired bytes", async () => {
  const h = harness({ contents: [null, good] });
  const job = h.agent.start(h.input); await h.agent.idle(job.id);
  const result = h.agent.get(job.id);
  expect(result.status).toBe("passed"); expect(result.attempts).toHaveLength(2);
  expect(result.attempts[0]?.evidence).toMatchObject({ passed: false, sha256: null });
  expect(result.attempts[1]?.feedback).toContain("exists");
  expect(result.attempts[1]?.evidence?.sha256).toHaveLength(64);
  expect(result.input).toEqual(h.input);
  expect(readFileSync(result.targetPath, "utf8")).toBe(good);
});

it("detects wrong content, preserves both evidence snapshots and respects the repair budget", async () => {
  const h = harness({ contents: ["# 错误\n真实文件", "# 验收示例\n仍不完整"] });
  const job = h.agent.start(h.input); await h.agent.idle(job.id);
  const result = h.agent.get(job.id);
  expect(result.status).toBe("failed"); expect(h.executor.create).toHaveBeenCalledTimes(2);
  expect(result.attempts[0]?.evidence?.sha256).not.toBe(result.attempts[1]?.evidence?.sha256);
  expect(result.attempts[1]?.feedback).toContain("heading");
});

it("passes first-time valid content without generating a repair and keeps creation idempotent", async () => {
  const h = harness({ contents: [good] });
  const job = h.agent.start(h.input); h.agent.start(h.input); await h.agent.idle(job.id);
  expect(h.agent.start(h.input).status).toBe("passed"); expect(h.executor.create).toHaveBeenCalledTimes(1);
  expect(() => h.agent.start({ ...h.input, title: "改变条件" })).toThrow("不能更改");
});

it("rejects pre-existing files, traversal and device names before dispatch", () => {
  const h = harness(); writeFileSync(join(h.desktop, h.input.fileName), "personal data");
  expect(() => h.agent.start(h.input)).toThrow("同名");
  expect(() => h.agent.start({ ...h.input, fileName: "../escape.md" })).toThrow();
  expect(() => h.agent.start({ ...h.input, fileName: "CON.md" })).toThrow();
  expect(h.executor.create).not.toHaveBeenCalled();
  expect(readFileSync(join(h.desktop, h.input.fileName), "utf8")).toBe("personal data");
});

it("rejects hard links and invalid UTF-8 instead of reading or accepting unrelated files", async () => {
  const h = harness({ contents: [good] }); const job = h.agent.start(h.input); await h.agent.idle(job.id);
  const result = h.agent.get(job.id);
  const other = join(h.desktop, "linked.md"); linkSync(result.targetPath, other);
  expect(verifyMarkdown(result)).toMatchObject({ passed: false, safeToRepair: false, sha256: null });
  const second = harness({ contents: [good] }); const job2 = second.agent.start(second.input); await second.agent.idle(job2.id);
  const result2 = second.agent.get(job2.id); writeFileSync(result2.targetPath, Buffer.from([0xff, 0xfe, 0x00]));
  expect(verifyMarkdown(result2).checks).toContainEqual(expect.objectContaining({ id: "utf8", passed: false }));
});

it("does not blindly resend creation when the response is uncertain", async () => {
  const h = harness(); vi.mocked(h.executor.create).mockRejectedValue(new Error("connection lost after submit"));
  const job = h.agent.start(h.input); await h.agent.idle(job.id);
  expect(h.agent.get(job.id).status).toBe("error");
  expect(() => h.agent.resume(job.id)).toThrow("缺少任务 ID");
  h.agent.start(h.input); expect(h.executor.create).toHaveBeenCalledTimes(1);
});

it("cancels a task whose creation finishes after the user stopped", async () => {
  const h = harness(); let resolveTask!: (value: { id: string }) => void;
  vi.mocked(h.executor.create).mockImplementation(() => new Promise(resolve => { resolveTask = resolve; }));
  const job = h.agent.start(h.input); await Promise.resolve();
  await h.agent.stop(job.id); resolveTask({ id: "late-task" }); await h.agent.idle(job.id);
  expect(h.executor.cancel).toHaveBeenCalledWith("late-task"); expect(h.agent.get(job.id).status).toBe("stopped");
});

it("recovers a known in-flight task after restart without submitting it again", async () => {
  const h = harness({ status: "running" }); const job = h.agent.start(h.input);
  await expect.poll(() => h.agent.get(job.id).attempts[0]?.taskId).toBe("task-1");
  await h.agent.close(); expect(h.agent.get(job.id).status).toBe("interrupted");
  writeFileSync(h.agent.get(job.id).targetPath, good);
  vi.mocked(h.executor.inspect).mockResolvedValue({ status: "completed" });
  const restarted = new AcceptanceAgent({ store: h.store, executor: h.executor, desktopRoot: () => h.desktop }); cleanup.push(() => restarted.close());
  restarted.resume(job.id); await restarted.idle(job.id);
  expect(restarted.get(job.id).status).toBe("passed"); expect(h.executor.create).toHaveBeenCalledTimes(1);
});

it("times out without claiming success or creating extra repair tasks", async () => {
  const h = harness({ status: "running", timeoutMs: 0 }); const job = h.agent.start(h.input); await h.agent.idle(job.id);
  expect(h.agent.get(job.id).status).toBe("error"); expect(h.executor.cancel).toHaveBeenCalledWith("task-1");
  expect(h.executor.create).toHaveBeenCalledTimes(1);
});

it("sends normal Hearth tasks with narrow file permissions and supports its actual response shape", async () => {
  const h = harness({ contents: [good] }); const job = h.agent.start(h.input); await h.agent.idle(job.id);
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? { id: "real-api-id" } : { task: { id: "real-api-id", status: "completed" } })));
  const executor = new HearthAcceptanceExecutor("http://127.0.0.1:4317", fetchImpl);
  await expect(executor.create(job, "heading: 标题缺失")).resolves.toEqual({ id: "real-api-id" });
  const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({ executorId: "native", taskKind: "general", expectedOutputs: [job.input.fileName], permissions: { writeRoots: [], readRoots: [], networkHosts: [] } });
  expect(body.goal).toContain("heading: 标题缺失"); expect(body.permissions.tools).not.toContain("shell");
  await expect(executor.inspect("real-api-id")).resolves.toMatchObject({ status: "completed" });
});

it("exposes history and evidence, rejects remote callers and invalid inputs", async () => {
  const h = harness({ contents: [good] }); const app = Fastify(); cleanup.push(() => app.close());
  await registerAcceptanceRoutes(app, h.agent, h.executor.baseUrl);
  expect((await app.inject("/api/acceptance/defaults")).json().desktopRoot).toBe(h.desktop);
  expect((await app.inject({ method: "POST", url: "/api/acceptance", payload: h.input, remoteAddress: "10.0.0.1" })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: "/api/acceptance", payload: { ...h.input, maxRepairs: 20 } })).statusCode).toBe(400);
  const created = await app.inject({ method: "POST", url: "/api/acceptance", payload: h.input }); expect(created.statusCode).toBe(202);
  await h.agent.idle(h.input.requestId);
  const result = await app.inject(`/api/acceptance/${h.input.requestId}`);
  expect(result.json().status).toBe("passed"); expect(result.headers["cache-control"]).toBe("no-store");
});

it("accepts an existing task artifact as the first attempt and dispatches only its repair", async () => {
  const h = harness();
  const first = artifact("# 错误"), repaired = artifact(good);
  h.executor.artifact = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(repaired);
  const job = h.agent.start({ ...h.input, requiredText: [], source: { taskId: "existing", artifactId: first.artifactId, name: "out.md" } }, "保留项目介绍");
  await h.agent.idle(job.id);
  const result = h.agent.get(job.id);
  expect(result.status).toBe("passed");
  expect(result.attempts.map(a => a.taskId)).toEqual(["existing", "task-1"]);
  expect(h.executor.artifact).toHaveBeenNthCalledWith(1, "existing", "out.md");
  expect(h.executor.create).toHaveBeenCalledTimes(1);
});

it("starts acceptance with a plain Chinese filename and canonicalizes repeat requests", async () => {
  const h = harness({ contents: [good] });
  const job = h.agent.start({ ...h.input, fileName: " 项目介绍 " });
  await h.agent.idle(job.id);
  expect(h.agent.get(job.id).status).toBe("passed");
  expect(job.input.fileName).toBe("项目介绍.md");
  expect(h.agent.start({ ...h.input, fileName: "项目介绍.md" }).id).toBe(job.id);
  expect(h.executor.create).toHaveBeenCalledTimes(1);
});
