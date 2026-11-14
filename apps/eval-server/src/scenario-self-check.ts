import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { validateScenarioManifest } from "@hearth/eval-core";
import type { ScenarioSelfCheck, ScenarioBatchDetail } from "@hearth/eval-core";
import { reportSchema, scenarioBatchFromReport } from "./scenario-reports.ts";
import { z } from "zod";

const resultPrefix = "HEARTH_SELF_CHECK_RESULT ";
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const resultSchema = z.object({ markdown: z.string(), report: reportSchema, evidence: z.record(z.string(), z.unknown()) });

export class ScenarioSelfCheckService {
  private state: ScenarioSelfCheck = { status: "idle", output: "", markdown: null, total: null, passed: null };
  private child: ChildProcess | null = null;
  private completion: Promise<void> | null = null;
  private latestBatch: ScenarioBatchDetail | null = null;
  private latestEvidence: Record<string, unknown> = {};

  constructor(private readonly repoRoot: string) {}

  snapshot(): ScenarioSelfCheck { return { ...this.state }; }

  batch(): ScenarioBatchDetail | null { return this.latestBatch; }

  evidence(id: string, scenarioId: string, repetition: string): unknown {
    return this.latestBatch?.id === id ? this.latestEvidence[`${scenarioId}/${repetition}`] ?? null : null;
  }

  scenarios() {
    return validateScenarioManifest(JSON.parse(readFileSync(join(this.repoRoot, "eval/scenarios/scenarios.json"), "utf8")))
      .scenarios.map(({ id, title }) => ({ id, title }));
  }

  async start(scenarioId?: string): Promise<ScenarioSelfCheck> {
    if (this.state.status === "running") throw new Error("已有场景自检正在运行");
    const scenarios = this.scenarios();
    if (scenarioId && !scenarios.some((scenario) => scenario.id === scenarioId)) throw new Error("找不到这个场景");
    this.state = { status: "running", output: "正在准备隔离测试环境…\n", markdown: null, total: null, passed: null };
    let root: string;
    try {
      root = await mkdtemp(join(tmpdir(), "hearth-self-check-"));
    } catch (error) {
      this.fail(error);
      return this.snapshot();
    }
    this.completion = this.execute(root, scenarioId);
    return this.snapshot();
  }

  private async execute(root: string, scenarioId?: string): Promise<void> {
    let outcome: ScenarioSelfCheck["status"] = "error";
    const completed: { batch: ScenarioBatchDetail | null } = { batch: null };
    let evidence: Record<string, unknown> = {};
    try {
      await new Promise<void>((resolve, reject) => {
        const args = ["--import", tsxLoader, "scenario-runner/run-scenarios.ts"];
        if (scenarioId) args.push("--only", scenarioId);
        const child = spawn(process.execPath, args, {
          cwd: this.repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TSX_TSCONFIG_PATH: join(this.repoRoot, "scenario-runner/tsconfig.json"), HEARTH_SELF_CHECK_ROOT: root }
        });
        this.child = child;
        let buffer = "";
        let launchError: Error | null = null;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10 * 60_000);
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        const append = (text: string) => { this.state.output = (this.state.output + text).slice(-100_000); };
        const line = (text: string) => {
          if (!text.startsWith(resultPrefix)) { append(text + "\n"); return; }
          try {
            const result = resultSchema.parse(JSON.parse(text.slice(resultPrefix.length)));
            completed.batch = scenarioBatchFromReport(`self-check-${randomUUID()}`, result.report);
            evidence = result.evidence;
            this.state.markdown = result.markdown;
            this.state.total = completed.batch!.total;
            this.state.passed = completed.batch!.passed;
          } catch { append("无法解析场景报告\n"); }
        };
        child.stdout!.on("data", (text: string) => {
          buffer += text;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            line(buffer.slice(0, newline).trimEnd());
            buffer = buffer.slice(newline + 1);
          }
        });
        child.stderr!.on("data", append);
        child.on("error", (error) => { launchError = error; });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (buffer) line(buffer);
          this.child = null;
          if (launchError) { reject(launchError); return; }
          if (timedOut) { reject(new Error("场景自检超过 10 分钟，已停止")); return; }
          if (!this.state.markdown || (code !== 0 && code !== 1)) {
            reject(new Error(`场景进程异常退出（${code ?? "已终止"}）`)); return;
          }
          outcome = code === 0 && this.state.passed === this.state.total ? "passed" : "failed";
          resolve();
        });
      });
    } catch (error) {
      this.fail(error);
      this.state.status = "running";
    } finally {
      try { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch (error) { this.fail(new Error(`临时文件清理失败：${String(error)}`)); outcome = "error"; }
      if (completed.batch) {
        this.latestBatch = completed.batch;
        this.latestEvidence = evidence;
        this.state.batchId = this.latestBatch.id;
      }
      this.state.status = outcome;
    }
  }

  private fail(error: unknown) {
    this.state.status = "error";
    this.state.output += `\n${String(error)}`;
    this.state.markdown = `# 场景自检异常\n\n${this.state.output}`;
  }

  async close() {
    this.child?.kill();
    await this.completion;
  }
}
