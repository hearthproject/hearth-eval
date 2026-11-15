import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScenarioBatchDetail } from "@hearth/eval-core";
import { EmptyState, ErrorState, LoadingState, MetricCard, PageHeader } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { formatDate, formatPercent } from "../lib/labels.ts";
import "./scenarios.css";

const STATUS_LABELS = { passed: "通过", failed: "失败", error: "异常" };

export function ScenariosPage() {
  const queryClient = useQueryClient();
  const [scenarioId, setScenarioId] = useState("");
  const catalog = useQuery({ queryKey: ["scenario-catalog"], queryFn: api.scenarioCatalog });
  const selfCheck = useQuery({ queryKey: ["scenario-self-check"], queryFn: api.scenarioSelfCheck, refetchInterval: 1000 });
  const start = useMutation({
    mutationFn: () => api.startScenarioSelfCheck(scenarioId || undefined),
    onSuccess: (data) => queryClient.setQueryData(["scenario-self-check"], data),
    onError: () => { void selfCheck.refetch(); }
  });
  const checking = start.isPending || selfCheck.data?.status === "running";
  const [selectedBatch, setSelectedBatch] = useState("");
  const [search, setSearch] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const history = useQuery({ queryKey: ["scenario-batches"], queryFn: api.scenarioBatches, refetchInterval: 5_000 });
  const completedBatchId = selfCheck.data?.status === "running" ? undefined : selfCheck.data?.batchId;
  useEffect(() => {
    if (!completedBatchId) return;
    setSelectedBatch("");
    setSearch("");
    setFailedOnly(false);
    void queryClient.invalidateQueries({ queryKey: ["scenario-batches"] });
  }, [completedBatchId, queryClient]);
  const id = selectedBatch || history.data?.[0]?.id || "";
  const batch = useQuery({
    queryKey: ["scenario-batch", id],
    queryFn: () => api.scenarioBatch(id),
    enabled: Boolean(id)
  });

  const data = batch.data;
  const groups = new Map<string, ScenarioBatchDetail["runs"]>();
  for (const run of data?.runs ?? []) {
    const group = groups.get(run.scenarioId) ?? [];
    group.push(run);
    groups.set(run.scenarioId, group);
  }
  const term = search.trim().toLowerCase();
  const visible = Array.from(groups.values()).filter((runs) => {
    const first = runs[0]!;
    return (!failedOnly || runs.some((run) => run.status !== "passed")) &&
      `${first.title} ${first.scenarioId} ${first.mechanism}`.toLowerCase().includes(term);
  });

  return (
    <div className="page-stack">
      <PageHeader title="场景测试" description="查看白盒场景的运行历史、检查项和证据。" />
      <section className="panel" aria-label="场景自检">
        <div className="scenario-toolbar">
          <label>检查范围
            <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} disabled={checking}>
              <option value="">全部场景</option>
              {catalog.data?.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.title}</option>)}
            </select>
          </label>
          <button className="button" onClick={() => start.mutate()} disabled={checking || !catalog.data || !selfCheck.data}>
            {checking ? "正在自检…" : "开始自检"}
          </button>
          <span role="status" aria-live="polite">
            {checking ? "扫描程序，自我检查中…" : selfCheck.data?.status === "passed" ? `自检通过 · ${selfCheck.data.passed}/${selfCheck.data.total}` :
              selfCheck.data?.status === "failed" ? `自检完成，存在未通过项 · ${selfCheck.data.passed}/${selfCheck.data.total} 通过` :
              selfCheck.data?.status === "error" ? "自检运行异常，请查看日志" : "运行隔离场景，检查审批、执行和恢复行为"}
          </span>
        </div>
        {(catalog.error || selfCheck.error || start.error) && <ErrorState error={catalog.error ?? selfCheck.error ?? start.error} onRetry={() => { void catalog.refetch(); void selfCheck.refetch(); }} />}
        {selfCheck.data && selfCheck.data.status !== "idle" && (
          <div className="scenario-run">
            {checking ? <pre className="scenario-evidence">{selfCheck.data.output || "正在启动检查程序…"}</pre> : (
              <details open>
                <summary>log.md</summary>
                <pre className="scenario-evidence">{selfCheck.data.markdown}</pre>
              </details>
            )}
            <p>日志仅保留在当前服务内存中，下次自检会替换，重启服务后清空。</p>
          </div>
        )}
      </section>
      {history.error ? <ErrorState error={history.error} onRetry={() => void history.refetch()} /> :
        history.isPending ? <LoadingState /> :
        history.data?.length === 0 ? <EmptyState title="还没有场景报告" description="在评测项目目录运行 npm run eval:scenarios，报告生成后会出现在这里。" /> : (
          <>
            <div className="panel scenario-toolbar">
              <label>运行批次
                <select value={selectedBatch} onChange={(event) => setSelectedBatch(event.target.value)}>
                  <option value="">最近一次</option>
                  {history.data?.map((item) => (
                    <option key={item.id} value={item.id}>{formatDate(item.startedAt)} · {item.passed}/{item.total} 通过</option>
                  ))}
                </select>
              </label>
              {data && <span>{formatDate(data.startedAt)} · {groups.size} 个场景 · {data.total} 次运行</span>}
            </div>
            {batch.error ? <ErrorState error={batch.error} onRetry={() => void batch.refetch()} /> :
              !data ? <LoadingState /> : (
                <>
                  <section className="metric-grid" aria-label="运行统计">
                    <MetricCard label="通过" value={data.passed} tone="success" />
                    <MetricCard label="失败或异常" value={data.total - data.passed} tone={data.total > data.passed ? "danger" : "neutral"} />
                    <MetricCard label="通过率" value={formatPercent(data.total ? 100 * data.passed / data.total : null)} />
                    <MetricCard label="总耗时" value={formatDuration(Date.parse(data.completedAt) - Date.parse(data.startedAt))} />
                  </section>
                  <section className="panel scenario-list">
                    <div className="scenario-toolbar">
                      <label>搜索场景
                        <input type="search" placeholder="标题、ID 或机制" value={search} onChange={(event) => setSearch(event.target.value)} />
                      </label>
                      <label className="scenario-checkbox">
                        <input type="checkbox" checked={failedOnly} onChange={(event) => setFailedOnly(event.target.checked)} />
                        只看失败
                      </label>
                      <span>{visible.length} / {groups.size} 个场景</span>
                    </div>
                    {visible.length === 0 && <EmptyState title="没有匹配的场景" />}
                    {visible.map((runs) => {
                      const first = runs[0]!;
                      const passed = runs.filter((run) => run.status === "passed").length;
                      return (
                        <details className="scenario-group" key={`${id}/${first.scenarioId}`}>
                          <summary>
                            <strong>{first.title}</strong>
                            <span>{first.scenarioId} · {first.priority}</span>
                            <span className={passed === runs.length ? "scenario-pass" : "scenario-fail"}>{passed}/{runs.length} 通过</span>
                          </summary>
                          {runs.map((run) => <ScenarioRun key={run.repetition} batchId={id} run={run} />)}
                        </details>
                      );
                    })}
                  </section>
                </>
              )}
          </>
        )}
    </div>
  );
}

function ScenarioRun({ batchId, run }: { batchId: string; run: ScenarioBatchDetail["runs"][number] }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const evidence = useQuery({
    queryKey: ["scenario-evidence", batchId, run.scenarioId, run.repetition],
    queryFn: () => api.scenarioEvidence(batchId, run.scenarioId, run.repetition),
    enabled: showEvidence
  });

  return (
    <div className="scenario-run">
      <h3>第 {run.repetition} 次 · <span className={run.status === "passed" ? "scenario-pass" : "scenario-fail"}>{STATUS_LABELS[run.status]}</span> · {formatDuration(run.durationMs)}</h3>
      {run.error && <p className="scenario-fail">{run.error}</p>}
      <ul className="scenario-checks">
        {run.assertions.map((assertion, index) => (
          <li key={`${assertion.name}/${index}`}>
            <span className={assertion.passed ? "scenario-pass" : "scenario-fail"}>{assertion.passed ? "通过" : "失败"}</span>
            <strong>{assertion.name}</strong>
            {assertion.detail && <span>{assertion.detail}</span>}
          </li>
        ))}
      </ul>
      {run.hasEvidence && (
        <>
          <button type="button" className="button" aria-expanded={showEvidence} onClick={() => setShowEvidence(!showEvidence)}>
            {showEvidence ? "收起证据" : "查看证据"}
          </button>
          {showEvidence && (evidence.error ? <ErrorState error={evidence.error} onRetry={() => void evidence.refetch()} /> :
            evidence.isPending ? <LoadingState text="正在读取证据" /> :
            <pre className="scenario-evidence">{JSON.stringify(evidence.data, null, 2)}</pre>)}
        </>
      )}
    </div>
  );
}

function formatDuration(ms: number) {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(2)} s`;
}
