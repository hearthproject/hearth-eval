import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Download, FolderOpen, Play, RefreshCw, TerminalSquare } from "lucide-react";
import type { BenchmarkImportInput, BenchmarkRun } from "@hearth/eval-core/browser";
import { formatBenchmarkTokens } from "@hearth/eval-core/browser";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  SectionHeader
} from "../components/ui.tsx";
import "./benchmark.css";

function formatReward(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatMoney(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function runTone(run: BenchmarkRun): string {
  if (run.status === "partial") return "warning";
  if (run.status === "error") return "danger";
  return "success";
}

function BenchmarkStatus({ run }: { run: BenchmarkRun }) {
  return <span className={`benchmark-status tone-${runTone(run)}`}>{run.status === "imported" ? "已导入" : run.status}</span>;
}

export function BenchmarksPage() {
  const queryClient = useQueryClient();
  const [jobDir, setJobDir] = useState("");
  const [datasetName, setDatasetName] = useState("terminal-bench/terminal-bench-2-1");
  const [datasetVersion, setDatasetVersion] = useState("2.1");
  const [harnessName, setHarnessName] = useState("hearth-native");
  const [harnessVersion, setHarnessVersion] = useState("");
  const [model, setModel] = useState("");
  const [pricingInput, setPricingInput] = useState("");
  const [pricingOutput, setPricingOutput] = useState("");
  const [pricingCached, setPricingCached] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const runsQuery = useQuery({ queryKey: ["benchmarks"], queryFn: api.benchmarks });
  const jobsQuery = useQuery({ queryKey: ["benchmark-jobs"], queryFn: api.benchmarkJobs });

  useEffect(() => {
    const first = jobsQuery.data?.jobs[0];
    if (!jobDir && first) setJobDir(first.path);
  }, [jobDir, jobsQuery.data]);

  const importMutation = useMutation({
    mutationFn: (dryRun: boolean) => {
      const input: BenchmarkImportInput = {
        jobDir,
        datasetName: datasetName.trim() || undefined,
        datasetVersion: datasetVersion.trim() || undefined,
        harnessName: harnessName.trim() || undefined,
        harnessVersion: harnessVersion.trim() || undefined,
        model: model.trim() || undefined,
        dryRun
      };
      if (pricingInput.trim() && pricingOutput.trim()) {
        input.pricing = {
          inputPerMillionUsd: Number(pricingInput),
          outputPerMillionUsd: Number(pricingOutput),
          ...(pricingCached.trim() ? { cachedPerMillionUsd: Number(pricingCached) } : {})
        };
      }
      return api.importBenchmark(input);
    },
    onSuccess: (result) => {
      setNotice(
        `${result.dryRun ? "预览" : "导入"}完成：${result.runId}，${result.trialCount} 个 trial，mean reward ${formatReward(result.summary.meanReward)}。`
      );
      if (!result.dryRun) void queryClient.invalidateQueries({ queryKey: ["benchmarks"] });
    }
  });

  function runImport(dryRun: boolean) {
    setNotice(null);
    if (!jobDir.trim()) {
      setNotice("请选择或填写 Harbor job 目录。");
      return;
    }
    importMutation.mutate(dryRun);
  }

  function submit(event: FormEvent<HTMLFormElement>, dryRun: boolean) {
    event.preventDefault();
    runImport(dryRun);
  }

  const runs = runsQuery.data?.runs ?? [];
  const latest = runs[0];

  return (
    <div className="page-stack benchmark-page">
      <PageHeader
        title="公开 Benchmark"
        description="Harbor 执行 Terminal-Bench，hearth-eval 只读导入 job 结果。这里只记录 verifier reward、token、耗时和成本，不用 LLM judge 改写分数。"
        actions={<a className="button" href="https://harborframework.com/docs/use-cases/evals" target="_blank" rel="noreferrer"><TerminalSquare size={15} /> Harbor 文档</a>}
      />

      {runsQuery.isLoading ? <LoadingState text="正在读取 benchmark runs" /> : null}
      {runsQuery.error ? <ErrorState error={runsQuery.error} onRetry={() => void runsQuery.refetch()} /> : null}

      {!runsQuery.isLoading && !runsQuery.error ? (
        <section className="benchmark-metric-grid">
          <MetricCard label="已导入 run" value={runs.length} detail="同一 job 幂等" icon={<BarChart3 size={16} />} />
          <MetricCard label="最新 mean reward" value={formatReward(latest?.summary?.meanReward ?? null)} detail={latest ? latest.jobId : "还没有 run"} tone="accent" />
          <MetricCard label="最新 pass@5" value={formatReward(latest?.summary?.passAt5 ?? null)} detail={latest?.summary?.passAt5TaskCount ? `${latest.summary.passAt5TaskCount} 题有 5 次 trial` : "不足 5 次/task"} />
          <MetricCard label="最新 tokens" value={formatBenchmarkTokens(latest?.summary?.totalTokens ?? null)} detail={latest ? `输入 ${formatBenchmarkTokens(latest.summary?.inputTokens)} / 输出 ${formatBenchmarkTokens(latest.summary?.outputTokens)}` : "—"} />
          <MetricCard label="最新成本" value={formatMoney(latest?.summary?.costUsd ?? null)} detail={latest?.summary?.costPerSolvedUsd != null ? `${formatMoney(latest.summary.costPerSolvedUsd)} / solved task` : "未提供单价"} />
        </section>
      ) : null}

      <section className="panel benchmark-import-panel">
        <SectionHeader
          title="导入 Harbor job"
          detail={<span>jobs root：<code>{jobsQuery.data?.root ?? "—"}</code></span>}
          action={<button className="button button-ghost" type="button" onClick={() => void jobsQuery.refetch()} disabled={jobsQuery.isFetching}><RefreshCw size={14} /> 刷新目录</button>}
        />
        <form className="benchmark-import-grid" onSubmit={(event) => submit(event, false)}>
          <label className="field-label benchmark-field-wide">Job 目录
            <div className="benchmark-input-with-icon">
              <FolderOpen size={15} />
              <input
                value={jobDir}
                onChange={(event) => setJobDir(event.target.value)}
                list="benchmark-job-candidates"
                placeholder="harbor-job-mini"
                required
              />
            </div>
            <datalist id="benchmark-job-candidates">
              {(jobsQuery.data?.jobs ?? []).map((job) => <option key={job.path} value={job.path}>{job.trialCount} trials</option>)}
            </datalist>
            <small>{jobsQuery.data?.jobs.length ?? 0} 个候选目录；可直接填相对路径。</small>
          </label>
          <label className="field-label">Dataset<input value={datasetName} onChange={(event) => setDatasetName(event.target.value)} /></label>
          <label className="field-label">Version<input value={datasetVersion} onChange={(event) => setDatasetVersion(event.target.value)} /></label>
          <label className="field-label">Harness<input value={harnessName} onChange={(event) => setHarnessName(event.target.value)} /></label>
          <label className="field-label">Harness version<input value={harnessVersion} onChange={(event) => setHarnessVersion(event.target.value)} placeholder="0.1.0" /></label>
          <label className="field-label">Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" /></label>
          <label className="field-label">Input $/1M<input type="number" min="0" step="0.01" value={pricingInput} onChange={(event) => setPricingInput(event.target.value)} placeholder="3.00" /></label>
          <label className="field-label">Output $/1M<input type="number" min="0" step="0.01" value={pricingOutput} onChange={(event) => setPricingOutput(event.target.value)} placeholder="15.00" /></label>
          <label className="field-label">Cached $/1M<input type="number" min="0" step="0.01" value={pricingCached} onChange={(event) => setPricingCached(event.target.value)} placeholder="可选" /></label>
          <div className="benchmark-import-actions">
            <button className="button" type="button" onClick={() => runImport(true)} disabled={importMutation.isPending}>仅预览</button>
            <button className="button button-primary" type="submit" disabled={importMutation.isPending}><Play size={15} /> {importMutation.isPending ? "导入中…" : "导入 job"}</button>
          </div>
        </form>
        {notice ? <div className="benchmark-notice">{notice}</div> : null}
        {importMutation.error ? <div className="benchmark-notice danger">{importMutation.error instanceof Error ? importMutation.error.message : String(importMutation.error)}</div> : null}
        {jobsQuery.error ? <div className="benchmark-notice danger">读取 Harbor jobs 失败：{jobsQuery.error instanceof Error ? jobsQuery.error.message : String(jobsQuery.error)}</div> : null}
      </section>

      <section className="panel">
        <SectionHeader title="Benchmark runs" detail="按导入时间倒序" action={<span className="benchmark-hint"><Download size={14} /> 详情页可导出 CSV</span>} />
        {runsQuery.isLoading ? <LoadingState text="正在读取 benchmark runs" /> : null}
        {!runsQuery.isLoading && runs.length === 0 ? <EmptyState title="还没有 benchmark run" description="先在左侧选择 Harbor job，或运行 npm run bench:import。" /> : null}
        {runs.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table benchmark-runs-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Dataset</th>
                  <th>Harness / Model</th>
                  <th>Tasks / Trials</th>
                  <th>Mean reward</th>
                  <th>pass@5</th>
                  <th>Tokens</th>
                  <th>Cost</th>
                  <th>导入时间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td><code title={run.id}>{run.jobId}</code><small className="benchmark-run-id">{run.id}</small></td>
                    <td>{run.datasetId.split("@")[0]}<small>{run.datasetId.split("@")[1]}</small></td>
                    <td>{run.harnessName}<small>{run.harnessVersion} · {run.model}</small></td>
                    <td>{run.summary?.totalTasks ?? "—"} / {run.summary?.totalTrials ?? "—"}</td>
                    <td><strong>{formatReward(run.summary?.meanReward ?? null)}</strong></td>
                    <td>{formatReward(run.summary?.passAt5 ?? null)}</td>
                    <td>{formatBenchmarkTokens(run.summary?.totalTokens ?? null)}</td>
                    <td>{formatMoney(run.summary?.costUsd ?? null)}</td>
                    <td>{formatDate(run.createdAt)}</td>
                    <td><BenchmarkStatus run={run} /></td>
                    <td><Link className="button button-ghost" to={`/benchmarks/${run.id}`}>详情</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
