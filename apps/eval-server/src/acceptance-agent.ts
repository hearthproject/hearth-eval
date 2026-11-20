import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { AcceptanceEvidence, AcceptanceInput, AcceptanceJob } from "@hearth/eval-core";
import type { EvalStore } from "./store.ts";
import type { AcceptanceExecutor } from "./acceptance-executor.ts";
import { deliverArtifact } from "./acceptance-delivery.ts";
import type { JudgeAdapter } from "./judge-adapter.ts";
import { reviewAcceptance } from "./acceptance-review.ts";

export const memoryKeySchema = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

export const acceptanceInputSchema = z.object({
  requestId: z.string().uuid(),
  fileName: z.string().trim().min(4).max(120).regex(/^[^<>:"/\\|?*\x00-\x1f]+\.md$/i)
    .refine(value => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value), "不支持的文件名"),
  title: z.string().trim().min(1).max(120).refine(value => !/[\r\n]/.test(value), "标题必须为单行"),
  requiredText: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  maxRepairs: z.number().int().min(0).max(1).default(1),
  memoryKey: memoryKeySchema.optional(),
  memoryRevision: z.number().int().positive().optional(),
  semanticRequirements: z.string().trim().min(1).max(500).optional()
}).strict().refine(input => (!input.memoryKey && !input.semanticRequirements && !input.memoryRevision) || Boolean(input.memoryKey && input.semanticRequirements && input.memoryRevision), "共享记忆、版本和语义要求必须同时提供");

export function desktopDirectory(): string {
  if (process.env.HEARTH_EVAL_DESKTOP_DIR) return resolve(process.env.HEARTH_EVAL_DESKTOP_DIR);
  if (process.platform === "win32") {
    const path = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop')"],
    { encoding: "utf8", timeout: 5000, windowsHide: true }).replace(/^\uFEFF/, "").trim();
    if (!path) throw new Error("无法识别桌面目录，请配置 HEARTH_EVAL_DESKTOP_DIR");
    return path;
  }
  return join(homedir(), "Desktop");
}

/** Reads the real artifact, never the executor's self-reported success or generated prose. */
export function verifyMarkdown(job: AcceptanceJob, onText?: (text: string) => void): AcceptanceEvidence {
  const result: AcceptanceEvidence = { checkedAt: new Date().toISOString(), targetPath: job.targetPath,
    sha256: null, bytes: null, checks: [], passed: false, safeToRepair: true };
  const check = (id: string, passed: boolean, reason: string) => result.checks.push({ id, passed, reason });
  let fd: number | null = null;
  try {
    if (dirname(job.targetPath) !== realpathSync(job.desktopRoot) || basename(job.targetPath) !== job.input.fileName) {
      throw new Error("桌面目录已变化或目标路径越界");
    }
    let stat;
    try { stat = lstatSync(job.targetPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { check("exists", false, "指定桌面路径没有文件；仅回复内容或写入其他目录不算完成"); return result; }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || realpathSync(job.targetPath) !== job.targetPath) {
      throw new Error("目标必须是桌面下的普通文件，不接受目录、符号链接或硬链接");
    }
    if (stat.size > 256_000) { check("size", false, "文件超过 256 KB，请缩减到验收要求所需内容"); return result; }
    fd = openSync(job.targetPath, "r");
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 256_000) throw new Error("读取期间文件发生变化，请重新验收");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.length > 256_000) throw new Error("读取期间文件发生变化，请重新验收");
    result.bytes = bytes.length; result.sha256 = createHash("sha256").update(bytes).digest("hex");
    check("exists", true, "在指定桌面路径读取到实际文件");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { check("utf8", false, "文件不是有效 UTF-8 文本，请使用 UTF-8 保存"); return result; }
    check("utf8", true, "有效 UTF-8 文本");
    onText?.(text);
    check("not_empty", Boolean(text.trim()), "文件必须包含非空文本");
    const heading = text.split(/\r?\n/).find(line => line.trim())?.trim();
    check("heading", heading === `# ${job.input.title}`, `首个非空行应为：# ${job.input.title}`);
    job.input.requiredText.forEach((required, index) => check(`required_${index + 1}`, text.includes(required), `正文应包含：${required}`));
    result.passed = result.checks.every(item => item.passed);
  } catch (error) {
    result.safeToRepair = false;
    check("readable_path", false, error instanceof Error ? error.message : String(error));
  } finally { if (fd !== null) closeSync(fd); }
  return result;
}

type Storage = Pick<EvalStore, "getAcceptance" | "saveAcceptance" | "listAcceptances" | "getSharedMemory" | "saveSharedMemory">;
const running = new Set(["running", "waiting_approval", "waiting_input"]);
const terminalTask = new Set(["completed", "failed", "cancelled"]);

export class AcceptanceAgent {
  private readonly active = new Map<string, { job: AcceptanceJob; abort: AbortController; promise: Promise<void> }>();
  constructor(private readonly options: { store: Storage; executor: AcceptanceExecutor; desktopRoot: () => string; pollMs?: number; timeoutMs?: number; judge?: JudgeAdapter & { modelSettings?: () => Promise<{ configured: boolean }> } }) {
    for (const job of options.store.listAcceptances()) {
      if (running.has(job.status)) { job.status = "interrupted"; job.error = "服务重启；Hearth 任务可能仍在运行。继续只跟踪已知任务，不重复提交。"; this.save(job); }
    }
  }
  private save(job: AcceptanceJob) { job.updatedAt = new Date().toISOString(); this.options.store.saveAcceptance(job); }
  get(id: string): AcceptanceJob { const job = this.options.store.getAcceptance(id); if (!job) throw new Error("验收记录不存在"); return job; }
  list() { return this.options.store.listAcceptances(); }
  root() { return realpathSync(this.options.desktopRoot()); }
  memory(key: string): import("@hearth/eval-core").AcceptanceMemoryView {
    key = memoryKeySchema.parse(key);
    return { memory: this.options.store.getSharedMemory(key), outcomes: this.list().filter(job => job.contextSnapshot?.key === key && ["passed", "failed"].includes(job.status)).slice(0, 20).map(job => ({
      jobId: job.id, status: job.status, snapshotHash: job.contextSnapshot!.sha256, revision: job.contextSnapshot!.revision, fileName: job.input.fileName,
      artifactHash: job.attempts.at(-1)?.evidence?.sha256 ?? null, updatedAt: job.updatedAt,
      failures: job.attempts.at(-1)?.evidence?.checks.filter(check => !check.passed).map(check => check.reason) ?? []
    })) };
  }
  saveMemory(key: string, raw: unknown) {
    const input = z.object({ content: z.string().trim().min(1).max(1500), expectedRevision: z.number().int().min(0) }).strict().parse(raw);
    return this.options.store.saveSharedMemory(memoryKeySchema.parse(key), input.content, input.expectedRevision);
  }
  async checkReviewer(input: AcceptanceInput) {
    if (!input.semanticRequirements || this.options.store.getAcceptance(input.requestId)) return;
    if (!this.options.judge || (this.options.judge.modelSettings && !(await this.options.judge.modelSettings()).configured)) {
      throw new Error("请先在系统页配置独立模型评委，再开始共享记忆语义验收");
    }
  }
  start(raw: AcceptanceInput): AcceptanceJob {
    const input = acceptanceInputSchema.parse(raw);
    const existing = this.options.store.getAcceptance(input.requestId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error("同一请求 ID 不能更改验收要求");
      return existing;
    }
    if (this.active.size) throw new Error("已有交付验收正在执行，请先完成或停止");
    const memory = input.memoryKey ? this.options.store.getSharedMemory(input.memoryKey) : null;
    if (input.memoryKey && (!memory || memory.revision !== input.memoryRevision)) throw new Error("共享记忆不存在或版本已变化，请重新读取后开始");
    if (input.semanticRequirements && !this.options.judge) throw new Error("语义评委不可用");
    const desktopRoot = this.root();
    const targetPath = join(desktopRoot, input.fileName);
    try { lstatSync(targetPath); throw new Error("桌面已有同名文件，请换一个文件名；不会覆盖已有文件"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.list().some(job => job.targetPath.toLowerCase() === targetPath.toLowerCase() && !["passed", "failed", "stopped"].includes(job.status))) {
      throw new Error("该路径还有未结束或状态不明的验收，请先处理旧任务");
    }
    const now = new Date().toISOString();
    const job: AcceptanceJob = { id: input.requestId, input, targetPath, desktopRoot, executor: "hearth",
      executorUrl: this.options.executor.baseUrl, status: "running", createdAt: now, updatedAt: now, attempts: [], error: null };
    if (memory) job.contextSnapshot = { ...memory, capturedAt: now };
    this.save(job); this.launch(job); return this.get(job.id);
  }
  resume(id: string): AcceptanceJob {
    const job = this.get(id);
    if (this.active.size || !["interrupted", "error"].includes(job.status)) throw new Error("当前不能继续");
    if (!job.attempts.at(-1)?.taskId) throw new Error("缺少任务 ID，无法确认是否已提交，请先在 Hearth 检查；不会自动重发");
    if (job.executorUrl !== this.options.executor.baseUrl) throw new Error("Hearth 地址已变化，无法继续原任务");
    job.status = "running"; job.error = null; this.save(job); this.launch(job); return this.get(id);
  }
  async stop(id: string): Promise<AcceptanceJob> {
    const active = this.active.get(id);
    const job = active?.job ?? this.get(id);
    if (["passed", "failed", "stopped"].includes(job.status)) return job;
    job.status = "stopped"; job.error = "用户停止；已生成的文件保留。";
    active?.abort.abort(); this.save(job);
    const taskId = job.attempts.at(-1)?.taskId;
    if (taskId) {
      try { await this.options.executor.cancel(taskId); }
      catch (error) { job.error += ` 取消 Hearth 任务未确认：${error instanceof Error ? error.message : String(error)}`; this.save(job); }
    }
    return this.get(id);
  }
  async close() {
    for (const item of this.active.values()) { item.abort.abort(); if (running.has(item.job.status)) { item.job.status = "interrupted"; item.job.error = "Eval 已停止；Hearth 任务可能继续运行，可稍后继续跟踪。"; this.save(item.job); } }
    await Promise.allSettled([...this.active.values()].map(item => item.promise));
  }
  async idle(id: string) { await this.active.get(id)?.promise; }
  private launch(job: AcceptanceJob) {
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => this.loop(job, abort.signal)).finally(() => this.active.delete(job.id));
    this.active.set(job.id, { job, abort, promise });
  }
  private async loop(job: AcceptanceJob, signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        let attempt = job.attempts.at(-1);
        if (!attempt || attempt.evidence) {
          if (attempt?.evidence?.passed) { job.status = "passed"; this.save(job); return; }
          if (attempt && (!attempt.evidence?.safeToRepair || job.attempts.length > job.input.maxRepairs)) { job.status = "failed"; this.save(job); return; }
          // Check the path again immediately before granting a repair write.
          if (attempt) { const current = verifyMarkdown(job); if (!current.safeToRepair) { job.status = "failed"; job.error = "目标路径已变化，停止自动修复"; this.save(job); return; } }
          else if (existsSync(job.targetPath)) throw new Error("任务提交前目标文件已出现，停止以避免覆盖");
          const feedback = attempt?.evidence?.checks.filter(item => !item.passed).map(item => `${item.id}: ${item.reason}`).join("\n") ?? null;
          attempt = { number: job.attempts.length + 1, taskId: null, taskStatus: "submitting", startedAt: new Date().toISOString(), finishedAt: null, feedback, evidence: null };
          job.attempts.push(attempt); this.save(job);
          // The ordinary Hearth creation API is not idempotent. Persist intent first and never retry an uncertain POST.
          const task = await this.options.executor.create(job, feedback);
          attempt.taskId = task.id; attempt.taskStatus = "queued"; this.save(job);
          if (signal.aborted) { if (job.status === "stopped") await this.options.executor.cancel(task.id); return; }
        }
        if (!attempt.taskId) throw new Error("提交结果不确定，缺少任务 ID；请在 Hearth 检查，不能自动重发");
        const deadline = Date.parse(attempt.startedAt) + (this.options.timeoutMs ?? 10 * 60_000);
        while (!signal.aborted) {
          const view = await this.options.executor.inspect(attempt.taskId);
          if (signal.aborted) return;
          attempt.taskStatus = view.status;
          job.status = view.status === "waiting_approval" ? "waiting_approval" : ["waiting_input", "recoverable"].includes(view.status) ? "waiting_input" : "running";
          this.save(job);
          if (terminalTask.has(view.status)) {
            attempt.finishedAt = new Date().toISOString();
            if (view.status !== "cancelled" && this.options.executor.artifact) {
              const artifact = await this.options.executor.artifact(attempt.taskId, job.input.fileName);
              if (signal.aborted) return;
              if (artifact) {
                const resumeHash = attempt.delivery?.sha256 ?? null;
                if (resumeHash && resumeHash !== artifact.sha256) throw new Error("已记录的交付来源发生变化，停止交付");
                attempt.delivery = { artifactId: artifact.artifactId, sha256: artifact.sha256, bytes: artifact.bytes.length, deliveredAt: null };
                this.save(job);
                deliverArtifact(job, artifact, job.attempts.at(-2)?.evidence?.sha256 ?? null, resumeHash);
                attempt.delivery.deliveredAt = new Date().toISOString(); this.save(job);
              }
            }
            let content = "";
            const evidence = verifyMarkdown(job, text => { content = text; });
            if (view.status !== "cancelled" && evidence.passed && job.input.semanticRequirements) {
              const semantic = await reviewAcceptance(this.options.judge!, job, content, evidence.sha256!);
              if (signal.aborted) return;
              const current = verifyMarkdown(job);
              if (!current.safeToRepair || current.sha256 !== evidence.sha256) throw new Error("语义评审期间文件已变化，请重新验收");
              attempt.semantic = semantic;
              evidence.checks.push(...semantic.criteria.map(item => ({ id: `semantic_${item.id}`, passed: item.passed, reason: item.reason })));
              evidence.passed = semantic.passed;
            }
            attempt.evidence = evidence;
            if (view.status === "cancelled") { job.status = "stopped"; job.error = "Hearth 任务已取消，不再发起修复"; this.save(job); return; }
            // Success means the artifact meets the contract, not merely that the executor said completed.
            this.save(job); break;
          }
          if (Date.now() >= deadline) {
            job.status = "error"; job.error = "单轮超过 10 分钟，停止跟踪并尝试取消；请到 Hearth 检查任务状态。"; this.save(job);
            try { await this.options.executor.cancel(attempt.taskId); } catch (error) { job.error += ` 取消未确认：${error instanceof Error ? error.message : String(error)}`; this.save(job); }
            return;
          }
          await delay(this.options.pollMs ?? 1500, undefined, { signal });
        }
      }
    } catch (error) {
      if (!signal.aborted) { job.status = "error"; job.error = error instanceof Error ? error.message : String(error); this.save(job); }
    }
  }
}
