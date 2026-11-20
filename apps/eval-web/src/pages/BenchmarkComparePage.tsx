import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, GitCompareArrows } from "lucide-react";
import type { BenchmarkCompareTask } from "@hearth/eval-core";
import { formatBenchmarkTokens } from "@hearth/eval-core";
import { Link, useSearchParams } from "react-router-dom";
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

function formatRewardDelta(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}pp`;
}

function formatMoneyDelta(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value > 0 ? "+" : ""}$${value.toFixed(2)}`;
}

function formatNumberDelta(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

function deltaTone(value: number | null | undefined): "success" | "danger" | "neutral" {
  if (value === null || value === undefined || value === 0) return "neutral";
  return value > 0 ? "success" : "danger";
}

function taskStatusLabel(status: BenchmarkCompareTask["status"]): string {
  const labels: Record<BenchmarkCompareTask["status"], string> = {
    improved: "改善",
    regressed: "退步",
    unchanged: "不变",
    added: "新增",
    missing: "缺失"
  };
  return labels[status];
}

function taskStatusTone(status: BenchmarkCompareTask["status"]): string {
  if (status === "improved") return "success";
  if (status === "regressed" || status === "missing") return "danger";
  if (status === "added") return "warning";
  return "neutral";
}

export function BenchmarkComparePage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<"all" | "improved" | "regressed" | "missing" | "added">("all");
  const baseline = params.get("baseline") ?? "";
  const candidate = params.get("candidate") ?? "";

  const runsQuery = useQuery({ queryKey: ["benchmarks"], queryFn: api.benchmarks });
  const compareQuery = useQuery({
    queryKey: ["benchmark-compare", baseline, candidate],
    queryFn: () => api.compareBenchmarks(candidate, baseline),
    enabled: Boolean(baseline && candidate && baseline !== candidate)
  });

  const runs = runsQuery.data?.runs ?? [];
  const taskRows = useMemo(() => {
    const tasks = compareQuery.data?.comparison.tasks ?? [];
    return filter === "all" ? tasks : tasks.filter((task) => task.status === filter);
  }, [compareQuery.data, filter]);

  function setParam(key: "baseline" | "candidate", value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  }

  const comparison = compareQuery.data?.comparison;

  return (
    <div className="page-stack benchmark-page">
      <PageHeader
        title="Benchmark 对比"
        description="固定 dataset 后比较两次 Harbor run。这里只展示事实差异，不自动给结论。"
        actions={<Link className="button button-ghost" to="/benchmarks"><ArrowLeft size={14} /> 返回列表</Link>}
      />

      <section className="panel benchmark-compare-picker">
        <SectionHeader title="选择 run" detail="baseline 为左边，candidate 为右边；模型不同会在结果里提示。" action={<GitCompareArrows size={18} />} />
        <div className="benchmark-compare-selects">
          <label className="field-label">Baseline
            <select value={baseline} onChange={(event) => setParam("baseline", event.target.value)}>
              <option value="">选择 baseline</option>
              {runs.map((run) => <option key={run.id} value={run.id}>{run.jobId} · {run.harnessName} · {formatReward(run.summary?.meanReward)}</option>)}
            </select>
          </label>
          <label className="field-label">Candidate
            <select value={candidate} onChange={(event) => setParam("candidate", event.target.value)}>
              <option value="">选择 candidate</option>
              {runs.map((run) => <option key={run.id} value={run.id}>{run.jobId} · {run.harnessName} · {formatReward(run.summary?.meanReward)}</option>)}
            </select>
          </label>
        </div>
        {baseline && candidate && baseline === candidate ? <div className="benchmark-notice danger">Baseline 和 Candidate 不能是同一个 run。</div> : null}
        {runs.length < 2 ? <div className="benchmark-notice">至少需要两个 run 才能对比；先导入另一个 Harbor job。</div> : null}
      </section>

      {runsQuery.isLoading || compareQuery.isLoading ? <LoadingState text="正在对比 benchmark runs" /> : null}
      {runsQuery.error ? <ErrorState error={runsQuery.error} onRetry={() => void runsQuery.refetch()} /> : null}
      {compareQuery.error ? <ErrorState error={compareQuery.error} onRetry={() => void compareQuery.refetch()} /> : null}
      {!baseline || !candidate ? <EmptyState title="选择两个 run" description="从上方选择 baseline 和 candidate，再查看逐题差异。" /> : null}

      {comparison ? (
        <>
          <section className="benchmark-metric-grid benchmark-compare-metrics">
            <MetricCard label="Mean reward Δ" value={formatRewardDelta(comparison.aggregate.meanRewardDelta)} detail={`${formatReward(comparison.aggregate.baseline.meanReward)} → ${formatReward(comparison.aggregate.candidate.meanReward)}`} tone={deltaTone(comparison.aggregate.meanRewardDelta)} />
            <MetricCard label="pass@5 Δ" value={formatRewardDelta(comparison.aggregate.passAt5Delta)} detail={`${formatReward(comparison.aggregate.baseline.passAt5)} → ${formatReward(comparison.aggregate.candidate.passAt5)}`} tone={deltaTone(comparison.aggregate.passAt5Delta)} />
            <MetricCard label="Resolved Δ" value={formatNumberDelta(comparison.aggregate.resolvedTaskDelta)} detail={`${comparison.aggregate.baseline.resolvedTasks} → ${comparison.aggregate.candidate.resolvedTasks} tasks`} tone={deltaTone(comparison.aggregate.resolvedTaskDelta)} />
            <MetricCard label="Tokens Δ" value={formatNumberDelta(comparison.aggregate.tokenDelta)} detail={`${formatBenchmarkTokens(comparison.aggregate.baseline.totalTokens)} → ${formatBenchmarkTokens(comparison.aggregate.candidate.totalTokens)}`} tone={comparison.aggregate.tokenDelta > 0 ? "warning" : "neutral"} />
            <MetricCard label="Cost Δ" value={formatMoneyDelta(comparison.aggregate.costDelta)} detail={comparison.aggregate.costDelta === null ? "至少一个 run 没有成本" : "已知成本差异"} />
          </section>

          {comparison.warnings.length > 0 ? (
            <div className="benchmark-notice">{comparison.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>
          ) : null}

          <section className="panel">
            <SectionHeader
              title="逐题差异"
              detail={`${taskRows.length} / ${comparison.tasks.length} tasks`}
              action={<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
                <option value="all">全部</option>
                <option value="improved">改善</option>
                <option value="regressed">退步</option>
                <option value="missing">缺失</option>
                <option value="added">新增</option>
              </select>}
            />
            {taskRows.length === 0 ? <EmptyState title="没有匹配的差异" description="切换到“全部”查看完整逐题表。" /> : (
              <div className="table-wrap">
                <table className="data-table benchmark-compare-table">
                  <thead>
                    <tr><th>Task</th><th>状态</th><th>Baseline best</th><th>Candidate best</th><th>Δ best</th><th>Baseline mean</th><th>Candidate mean</th><th>Tokens Δ</th><th>Attempts</th></tr>
                  </thead>
                  <tbody>
                    {taskRows.map((task) => (
                      <tr key={task.taskKey}>
                        <td><code>{task.taskKey}</code></td>
                        <td><span className={`benchmark-status tone-${taskStatusTone(task.status)}`}>{taskStatusLabel(task.status)}</span></td>
                        <td>{formatReward(task.baselineBestReward)}</td>
                        <td>{formatReward(task.candidateBestReward)}</td>
                        <td className={`benchmark-delta tone-${deltaTone(task.rewardDelta)}`}>{formatRewardDelta(task.rewardDelta)}</td>
                        <td>{formatReward(task.baselineMeanReward)}</td>
                        <td>{formatReward(task.candidateMeanReward)}</td>
                        <td className={task.tokenDelta > 0 ? "benchmark-delta tone-warning" : "benchmark-delta"}>{formatNumberDelta(task.tokenDelta)}</td>
                        <td>{task.baselineAttempts} → {task.candidateAttempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
