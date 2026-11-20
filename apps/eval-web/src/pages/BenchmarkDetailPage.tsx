import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, GitCompareArrows, RefreshCw, Search, X } from "lucide-react";
import type { BenchmarkTaskSummary, BenchmarkTrial } from "@hearth/eval-core";
import { formatBenchmarkTokens } from "@hearth/eval-core";
import { Link, useParams } from "react-router-dom";
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

function formatReward(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `$${value.toFixed(2)}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    passed: "通过",
    failed: "失败",
    partial: "部分通过",
    error: "错误",
    timeout: "超时",
    budget_exceeded: "预算耗尽",
    skipped: "跳过",
    imported: "已导入"
  };
  return labels[status] ?? status;
}

function statusTone(status: string): string {
  if (status === "passed" || status === "imported") return "success";
  if (status === "partial" || status === "budget_exceeded" || status === "skipped") return "warning";
  if (status === "failed" || status === "error" || status === "timeout") return "danger";
  return "neutral";
}

function Status({ status }: { status: string }) {
  return <span className={`benchmark-status tone-${statusTone(status)}`}>{statusLabel(status)}</span>;
}

function TaskRow({ task, onSelect }: { task: BenchmarkTaskSummary; onSelect: () => void }) {
  return (
    <tr className="benchmark-task-row" tabIndex={0} onClick={onSelect} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    }}>
      <td><code>{task.taskKey}</code></td>
      <td><Status status={task.status} /></td>
      <td>{task.attempts}</td>
      <td>{task.validAttempts}</td>
      <td><strong>{formatReward(task.bestReward)}</strong></td>
      <td>{formatReward(task.meanReward)}</td>
      <td>{formatBenchmarkTokens(task.totalTokens)}</td>
      <td>{formatDuration(task.avgDurationMs)}</td>
    </tr>
  );
}

function TrialDrawer({
  taskKey,
  trials,
  selectedTrial,
  trialDetail,
  onSelectTrial,
  onClose
}: {
  taskKey: string;
  trials: BenchmarkTrial[];
  selectedTrial: BenchmarkTrial | null;
  trialDetail: BenchmarkTrial | undefined;
  onSelectTrial: (trialId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="benchmark-drawer-scrim" onClick={onClose}>
      <aside className="benchmark-drawer" onClick={(event) => event.stopPropagation()} aria-label={`${taskKey} trial 明细`}>
        <header className="benchmark-drawer-head">
          <div><small>Task</small><strong>{taskKey}</strong></div>
          <button className="icon-button" type="button" aria-label="关闭 trial 明细" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="benchmark-drawer-body">
          <section>
            <SectionHeader title="Trials" detail={`${trials.length} 个`} />
            <div className="benchmark-trial-list">
              {trials.map((trial) => (
                <button
                  key={trial.id}
                  type="button"
                  className={`benchmark-trial-row ${selectedTrial?.id === trial.id ? "is-selected" : ""}`}
                  onClick={() => onSelectTrial(trial.id)}
                >
                  <span>#{trial.attempt}</span>
                  <Status status={trial.status} />
                  <strong>{formatReward(trial.reward)}</strong>
                  <small>{formatBenchmarkTokens((trial.inputTokens ?? 0) + (trial.outputTokens ?? 0))} tok</small>
                  <small>{formatDuration(trial.durationMs)}</small>
                </button>
              ))}
            </div>
          </section>

          {trialDetail ? (
            <section className="benchmark-trial-detail">
              <SectionHeader title="Trial evidence" detail={<code>{trialDetail.id}</code>} />
              <div className="benchmark-kv-grid">
                <div><small>Status</small><Status status={trialDetail.status} /></div>
                <div><small>Reward</small><strong>{formatReward(trialDetail.reward)}</strong></div>
                <div><small>Attempt</small><strong>{trialDetail.attempt}</strong></div>
                <div><small>Duration</small><strong>{formatDuration(trialDetail.durationMs)}</strong></div>
                <div><small>Input tokens</small><strong>{formatBenchmarkTokens(trialDetail.inputTokens)}</strong></div>
                <div><small>Output tokens</small><strong>{formatBenchmarkTokens(trialDetail.outputTokens)}</strong></div>
                <div><small>Cached tokens</small><strong>{formatBenchmarkTokens(trialDetail.cachedTokens)}</strong></div>
                <div><small>Cost</small><strong>{formatMoney(trialDetail.costUsd)}</strong></div>
              </div>
              {trialDetail.errorMessage ? <div className="benchmark-notice danger"><strong>{trialDetail.errorCode ?? "ERROR"}</strong> · {trialDetail.errorMessage}</div> : null}
              {trialDetail.verifierStdout ? <><h4>Verifier stdout</h4><pre className="benchmark-pre">{trialDetail.verifierStdout}</pre></> : null}
              {trialDetail.verifierStderr ? <><h4>Verifier stderr</h4><pre className="benchmark-pre">{trialDetail.verifierStderr}</pre></> : null}
              <h4>Raw result</h4>
              <pre className="benchmark-pre benchmark-raw">{JSON.stringify(trialDetail.raw, null, 2)}</pre>
            </section>
          ) : (
            <section><EmptyState title="选择一次 trial" description="查看 reward、token、耗时和 verifier 输出。" /></section>
          )}
        </div>
      </aside>
    </div>
  );
}

export function BenchmarkDetailPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null);
  const [selectedTrialId, setSelectedTrialId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedTaskKey(null);
    setSelectedTrialId(null);
  }, [id]);

  const detail = useQuery({ queryKey: ["benchmark", id], queryFn: () => api.benchmark(id), enabled: Boolean(id) });
  const taskTrials = useQuery({
    queryKey: ["benchmark-task-trials", id, selectedTaskKey],
    queryFn: () => api.benchmarkTrials(id, { taskKey: selectedTaskKey ?? "", limit: 1_000 }),
    enabled: Boolean(id && selectedTaskKey)
  });
  const trialDetail = useQuery({
    queryKey: ["benchmark-trial", id, selectedTrialId],
    queryFn: () => api.benchmarkTrial(id, selectedTrialId ?? ""),
    enabled: Boolean(id && selectedTrialId)
  });
  const reimport = useMutation({
    mutationFn: () => api.reimportBenchmark(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["benchmark", id] });
      void queryClient.invalidateQueries({ queryKey: ["benchmarks"] });
    }
  });

  const tasks = detail.data?.tasks ?? [];
  const filteredTasks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesSearch = !needle || task.taskKey.toLowerCase().includes(needle);
      const matchesStatus = !statusFilter || task.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [search, statusFilter, tasks]);

  if (detail.isLoading) return <div className="page-stack"><LoadingState text="正在读取 benchmark run" /></div>;
  if (detail.error) return <div className="page-stack"><ErrorState error={detail.error} onRetry={() => void detail.refetch()} /></div>;
  if (!detail.data) return <div className="page-stack"><EmptyState title="Run 不存在" description="检查 URL 或从 Benchmark 列表重新进入。" /></div>;

  const run = detail.data.run;
  const summary = run.summary;
  const trialsForTask = taskTrials.data?.trials ?? [];
  const selectedTrial = trialsForTask.find((trial) => trial.id === selectedTrialId) ?? null;
  const selectedTrialData = trialDetail.data?.trial;

  return (
    <div className="page-stack benchmark-page">
      <PageHeader
        title={run.jobId}
        description={<span>{run.datasetId} · {run.harnessName} {run.harnessVersion} · {run.model}</span>}
        actions={<>
          <Link className="button button-ghost" to="/benchmarks"><ArrowLeft size={14} /> 返回列表</Link>
          <Link className="button button-ghost" to={`/benchmarks/compare?candidate=${id}`}><GitCompareArrows size={14} /> 对比</Link>
          <button className="button button-ghost" type="button" onClick={() => reimport.mutate()} disabled={reimport.isPending}>
            <RefreshCw size={14} /> {reimport.isPending ? "重导入中…" : "重导入"}
          </button>
          <a className="button" href={api.benchmarkExportUrl(id)}><Download size={14} /> CSV</a>
        </>}
      />

      <section className="benchmark-metric-grid">
        <MetricCard label="Mean reward" value={formatReward(summary?.meanReward)} detail={summary?.wilson95 ? `95% Wilson ${formatReward(summary.wilson95.lower)}–${formatReward(summary.wilson95.upper)}` : "—"} tone="accent" />
        <MetricCard label="pass@5" value={formatReward(summary?.passAt5)} detail={summary?.passAt5TaskCount ? `${summary.passAt5TaskCount} 题有 5 次 trial` : "不足 5 次/task"} />
        <MetricCard label="Tasks resolved" value={`${summary?.resolvedTasks ?? "—"} / ${summary?.totalTasks ?? "—"}`} detail={`${summary?.validTrials ?? "—"} valid trials`} />
        <MetricCard label="Tokens" value={formatBenchmarkTokens(summary?.totalTokens)} detail={`in ${formatBenchmarkTokens(summary?.inputTokens)} · out ${formatBenchmarkTokens(summary?.outputTokens)}`} />
        <MetricCard label="Cost" value={formatMoney(summary?.costUsd)} detail={summary?.costPerSolvedUsd != null ? `${formatMoney(summary.costPerSolvedUsd)} / solved` : "未提供单价"} />
        <MetricCard label="Infra errors" value={formatReward(summary?.infraErrorRate)} detail={`${summary?.errorTrials ?? 0} error · ${summary?.timeoutTrials ?? 0} timeout · ${summary?.budgetExceededTrials ?? 0} budget`} tone={summary?.infraErrorRate ? "warning" : "neutral"} />
      </section>

      {reimport.error ? <div className="benchmark-notice danger">重导入失败：{reimport.error instanceof Error ? reimport.error.message : String(reimport.error)}</div> : null}

      <section className="panel">
        <SectionHeader
          title="逐题结果"
          detail={`${filteredTasks.length} / ${tasks.length} tasks`}
          action={<div className="benchmark-filter-row">
            <div className="search-field"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 task" /></div>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">全部状态</option>
              <option value="passed">通过</option>
              <option value="failed">失败</option>
              <option value="partial">部分通过</option>
              <option value="error">错误</option>
              <option value="timeout">超时</option>
              <option value="budget_exceeded">预算耗尽</option>
            </select>
          </div>}
        />
        {filteredTasks.length === 0 ? <EmptyState title="没有匹配的 task" description="清除筛选，或检查导入的 trial。" /> : (
          <div className="table-wrap">
            <table className="data-table benchmark-task-table">
              <thead>
                <tr><th>Task</th><th>状态</th><th>Attempts</th><th>Valid</th><th>Best reward</th><th>Mean</th><th>Tokens</th><th>平均耗时</th></tr>
              </thead>
              <tbody>
                {filteredTasks.map((task) => (
                  <TaskRow key={task.taskKey} task={task} onSelect={() => { setSelectedTaskKey(task.taskKey); setSelectedTrialId(null); }} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedTaskKey ? (
        <TrialDrawer
          taskKey={selectedTaskKey}
          trials={trialsForTask}
          selectedTrial={selectedTrial}
          trialDetail={selectedTrialData}
          onSelectTrial={setSelectedTrialId}
          onClose={() => { setSelectedTaskKey(null); setSelectedTrialId(null); }}
        />
      ) : null}
    </div>
  );
}
