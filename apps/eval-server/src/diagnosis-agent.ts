import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DiagnosisJob, ExperimentRunRecord } from "@hearth/eval-core";
import type { EvalStore } from "./store.ts";
import type { EvalRunner } from "./runner.ts";
import { resolveRunOutputDir } from "./artifact-path.ts";
import { decisionSchema, type DiagnosisDecision, type DiagnosisModel } from "./diagnosis-model.ts";

type Runner = Pick<EvalRunner, "collectEnvironment" | "createExperiment" | "start" | "cancel">;
interface Options {
  store: EvalStore; runner: Runner; model: DiagnosisModel;
  health: () => Promise<unknown>; repoRoot: string; artifactRoot: string;
  pollMs?: number; waitMs?: number;
}
const terminal = (status: string) => !["queued", "created", "running", "waiting", "grading"].includes(status);
const inside = (root: string, file: string) => { const path = relative(root, file); return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path); };

export class DiagnosisAgent {
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  constructor(private readonly options: Options) {
    // Resume is explicit after a process restart; never create a second rerun implicitly.
    for (const job of options.store.listDiagnoses()) {
      if (["running", "waiting_rerun"].includes(job.status)) {
        job.status = "stopped"; job.error = "服务重启，已保留检查点，可继续诊断"; this.save(job);
      }
    }
  }
  private save(job: DiagnosisJob) { job.updatedAt = new Date().toISOString(); this.options.store.saveDiagnosis(job); }
  get(id: string) { const job = this.options.store.getDiagnosis(id); if (!job) throw new Error("诊断不存在"); return job; }
  start(experimentId: string, rerunBudget = 0) {
    if (this.active.size) throw new Error("已有诊断正在执行");
    if (!this.options.store.getExperiment(experimentId)) throw new Error("实验不存在");
    if (![0, 1].includes(rerunBudget)) throw new Error("复跑预算只能是 0 或 1");
    const now = new Date().toISOString();
    const job: DiagnosisJob = { id: randomUUID(), experimentId, status: "running", createdAt: now, updatedAt: now,
      steps: 0, maxSteps: 12, rerunBudget, rerunsUsed: 0, pendingRunId: null, rerunExperimentId: null,
      evidence: [], report: null, error: null };
    this.save(job); this.launch(job.id); return job;
  }
  resume(id: string) {
    const job = this.get(id);
    if (this.active.size || !["stopped", "error"].includes(job.status)) throw new Error("当前诊断不能继续");
    if (job.steps >= job.maxSteps) throw new Error("决策步数已用尽，请查看已有证据");
    job.status = "running"; job.error = null; this.save(job); this.launch(id); return job;
  }
  approve(id: string, approved: boolean) {
    const job = this.get(id);
    if (this.active.size || job.status !== "waiting_approval" || !job.pendingRunId || job.rerunsUsed) throw new Error("当前没有可处理的复跑申请");
    if (approved) job.rerunBudget = 1;
    else { this.observe(job, { tool: "rerun", target: job.pendingRunId, path: "", reason: "用户拒绝复跑", report: null }, { denied: true }); job.pendingRunId = null; }
    job.status = "running"; this.save(job); this.launch(id); return job;
  }
  stop(id: string) {
    const job = this.get(id);
    if (job.status === "completed") throw new Error("诊断已完成");
    this.active.get(id)?.abort.abort();
    job.status = "stopped"; job.error = "用户停止"; this.save(job);
    // A separately created experiment remains visible; cancellation is best effort via the runner.
    if (job.rerunExperimentId) this.options.runner.cancel(job.rerunExperimentId);
    return job;
  }
  async close() {
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.allSettled([...this.active.values()].map(item => item.promise));
  }
  async idle(id: string) { await this.active.get(id)?.promise; }
  private launch(id: string) {
    const abort = new AbortController();
    const promise = Promise.resolve().then(() => this.loop(id, abort.signal)).finally(() => this.active.delete(id));
    this.active.set(id, { abort, promise });
  }
  private observe(job: DiagnosisJob, action: DiagnosisDecision, data: unknown, error = false) {
    const serialized = JSON.stringify(data);
    job.evidence.push({ id: `E${job.evidence.length + 1}`, tool: action.tool, target: action.target, path: action.path,
      reason: action.reason, at: new Date().toISOString(), error,
      data: serialized.length > 14000 ? serialized.slice(0, 14000) + "\n[内容已截断，不能作为完整证据]" : serialized });
    this.save(job);
  }
  private async loop(id: string, signal: AbortSignal) {
    const job = this.get(id);
    try {
      if (job.pendingRunId && job.rerunBudget && !job.rerunExperimentId) await this.rerun(job, job.pendingRunId, signal);
      if (job.rerunExperimentId && !job.evidence.some(e => e.tool === "rerun_result")) await this.waitRerun(job, signal);
      while (!signal.aborted && job.steps < job.maxSteps) {
        job.status = "running"; job.steps++; this.save(job);
        const action = decisionSchema.parse(await this.options.model.next(job, signal));
        signal.throwIfAborted();
        try {
          if (action.tool === "finish") {
            this.finish(job, action); return;
          }
          if (action.tool === "rerun") {
            this.validateRerun(job, action.target);
            if (job.evidence.some(e => e.tool === "rerun" && e.reason === "用户拒绝复跑")) throw new Error("用户已拒绝复跑，请根据现有证据报告限制");
            job.pendingRunId = action.target;
            if (!job.rerunBudget) {
              job.status = "waiting_approval"; this.observe(job, action, { approvalRequired: true, runs: 1 }); return;
            }
            this.observe(job, action, { authorized: true, runs: 1 });
            await this.rerun(job, action.target, signal);
            await this.waitRerun(job, signal);
          } else {
            const data = await this.readTool(action);
            signal.throwIfAborted(); this.observe(job, action, data);
          }
        } catch (error) {
          signal.throwIfAborted();
          // A wait timeout is a resumable checkpoint, not a completed diagnosis.
          if (this.get(id).status === "waiting_rerun") throw error;
          this.observe(job, action, { message: error instanceof Error ? error.message : String(error) }, true);
        }
      }
      signal.throwIfAborted();
      job.status = "stopped"; job.error = "达到 12 次模型决策上限；未生成完整报告"; this.save(job);
    } catch (error) {
      // Do not overwrite a user cancellation with a stale in-flight model result.
      const current = this.get(id);
      current.status = signal.aborted ? "stopped" : "error";
      current.error = signal.aborted ? "诊断已停止，检查点已保存" : (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      this.save(current);
    }
  }
  private validateRerun(job: DiagnosisJob, runId: string) {
    if (job.rerunsUsed >= 1) throw new Error("复跑预算已用尽（最多一次）");
    const run = this.options.store.getRun(runId);
    if (!run || run.experimentId !== job.experimentId || !terminal(run.status)) throw new Error("只能复跑目标实验中已结束的运行");
    if (!job.evidence.some(e => e.tool === "read_run" && e.target === runId && !e.error)) throw new Error("必须先读取该运行证据再申请复跑");
    const experiment = this.options.store.getExperiment(run.experimentId)!;
    if (experiment.config.runMode !== "offline") throw new Error("最小版本仅允许离线复跑；线上任务需要单独授权");
    if (this.options.store.getCase(run.caseKey)?.summary.contentHash !== run.caseContentHash) throw new Error("任务内容已变化，不能视为同条件复跑");
    return { run, experiment };
  }
  private async rerun(job: DiagnosisJob, runId: string, signal: AbortSignal) {
    const { run, experiment } = this.validateRerun(job, runId);
    const environment = await this.options.runner.collectEnvironment(experiment.environment.judgeModel);
    signal.throwIfAborted();
    const checkpoint = this.options.store.transaction(() => {
      const created = this.options.runner.createExperiment({ name: `诊断复跑 ${job.id.slice(0, 8)}`, caseIds: [run.caseKey],
        executorIds: [run.executorId], repetitions: 1, runMode: "offline", autoJudge: experiment.config.autoJudge,
        autoRetry: false, maxConcurrency: 1, baselineExperimentId: experiment.id }, environment);
      const next: DiagnosisJob = { ...job, rerunExperimentId: created.id, rerunsUsed: 1, status: "waiting_rerun" };
      this.save(next); return next;
    });
    Object.assign(job, checkpoint);
    this.options.runner.start(job.rerunExperimentId!);
  }
  private async waitRerun(job: DiagnosisJob, signal: AbortSignal) {
    job.status = "waiting_rerun"; this.save(job);
    const until = Date.now() + (this.options.waitMs ?? 180_000);
    while (Date.now() < until) {
      signal.throwIfAborted();
      const runs = this.options.store.listRuns(job.rerunExperimentId!);
      if (runs.length && runs.every(r => terminal(r.status))) {
        const before = job.pendingRunId ? this.options.store.getRun(job.pendingRunId) : null;
        const action = { tool: "read_run" as const, target: runs[0]!.id, path: "", reason: "复跑完成，读取新证据修正判断", report: null };
        const after = await this.runEvidence(runs[0]!);
        signal.throwIfAborted();
        this.observe(job, action, { before, after, experiment: this.options.store.getExperiment(job.rerunExperimentId!) });
        job.evidence[job.evidence.length - 1]!.tool = "rerun_result";
        job.status = "running"; job.pendingRunId = null; this.save(job); return;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error("诊断停止")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, this.options.pollMs ?? 1000);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw new Error("复跑尚未结束，已保留实验 ID；稍后点击继续读取结果，不会重复创建实验");
  }
  private async readTool(action: DiagnosisDecision): Promise<unknown> {
    const { store } = this.options;
    if (action.tool === "list_experiments") return store.listExperiments(20).map(e => ({ id: e.id, name: e.name, status: e.status, createdAt: e.createdAt, summary: e.summary }));
    if (action.tool === "health") return await this.options.health();
    if (action.tool === "read_experiment") {
      const experiment = store.getExperiment(action.target); if (!experiment) throw new Error("实验不存在");
      const runs = store.listRuns(experiment.id);
      const selected = [...runs].sort((a, b) => Number(a.status === "passed") - Number(b.status === "passed")).slice(0, 50);
      return { experiment, totalRuns: runs.length, omittedRuns: runs.length - selected.length, runs: selected };
    }
    const run = store.getRun(action.target); if (!run) throw new Error("运行不存在");
    if (action.tool === "read_run") return this.runEvidence(run);
    if (action.tool === "read_artifact") {
      const root = this.artifactDirectory(run);
      const path = realpathSync(resolve(root, action.path));
      if (!action.path || !inside(root, path) || !inside(realpathSync(this.options.artifactRoot), path)) throw new Error("产物路径超出运行目录");
      if (!statSync(path).isFile() || statSync(path).size > 256_000) throw new Error("仅支持不超过 256 KB 的文本产物");
      const text = readFileSync(path, "utf8"); if (text.includes("\0")) throw new Error("不是文本产物");
      return { path: action.path, text: text.slice(0, 12000), truncated: text.length > 12000 };
    }
    throw new Error("不支持的工具");
  }
  private artifactDirectory(run: ExperimentRunRecord) {
    const root = realpathSync(resolveRunOutputDir(this.options.repoRoot, this.options.artifactRoot, run.outputDir));
    if (!inside(realpathSync(this.options.artifactRoot), root)) throw new Error("产物目录不在允许范围");
    return root;
  }
  private async runEvidence(run: ExperimentRunRecord) {
    const artifacts: string[] = []; let artifactError: string | null = null;
    try {
      const root = this.artifactDirectory(run);
      const walk = (dir: string, depth: number) => {
        if (depth > 4 || artifacts.length >= 40) return;
        for (const name of readdirSync(dir)) {
          if (artifacts.length >= 40) break;
          const path = join(dir, name); const stat = lstatSync(path);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) walk(path, depth + 1);
          else if (stat.isFile()) artifacts.push(relative(root, path).replace(/\\/g, "/"));
        }
      }; walk(root, 0);
    } catch (error) { artifactError = error instanceof Error ? error.message : String(error); }
    return { run, artifacts, artifactError, artifactListingLimit: "最多40个文件、4层目录",
      graders: this.options.store.listGraderResults(run.id), review: this.options.store.getHumanReview(run.id),
      manifest: this.options.store.getCase(run.caseKey)?.manifest, trace: this.options.store.getTrace(run.id) };
  }
  private finish(job: DiagnosisJob, action: DiagnosisDecision) {
    if (!action.report) throw new Error("finish 需要报告");
    if (!job.evidence.some(e => e.tool === "read_experiment" && e.target === job.experimentId && !e.error) ||
        !job.evidence.some(e => e.tool === "read_run" && !e.error && this.options.store.getRun(e.target)?.experimentId === job.experimentId)) throw new Error("完成前必须检查目标实验和至少一个运行");
    for (const finding of action.report.findings) {
      if (finding.evidenceIds.some(id => !job.evidence.some(e => e.id === id && !e.error))) throw new Error("报告引用了不存在或失败的证据");
      if (finding.cause === "agent_regression" && !job.evidence.some(e => e.tool === "read_experiment" && e.target !== job.experimentId && !e.error)) throw new Error("判断退化前需读取对比实验，或使用 unknown 标注待验证");
    }
    if (job.rerunExperimentId && !job.evidence.some(e => e.tool === "rerun_result")) throw new Error("复跑尚未完成，不能提前报告闭环完成");
    job.report = action.report; job.status = "completed"; job.error = null; this.save(job);
  }
}
