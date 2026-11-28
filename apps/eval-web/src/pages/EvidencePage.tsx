import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeftRight,
  Binary,
  CheckCircle2,
  Coins,
  FlaskConical,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck
} from "lucide-react";
import { api } from "../lib/api.ts";

type JsonRecord = Record<string, unknown>;

const TABS = [
  { id: "provenance", label: "来源链", icon: GitBranch },
  { id: "manifest", label: "Manifest 差异", icon: ArrowLeftRight },
  { id: "replay", label: "Replay / 分叉", icon: Play },
  { id: "policy", label: "Policy 策略", icon: ShieldCheck },
  { id: "cost", label: "成本与降级", icon: Coins },
  { id: "failure", label: "失败转 Case", icon: AlertTriangle },
  { id: "variants", label: "Harness 变体", icon: Binary }
] as const;

type TabId = (typeof TABS)[number]["id"];

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? value as JsonRecord : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function valueText(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function short(value: unknown): string {
  const text = valueText(value, "");
  return text.length > 18 ? `${text.slice(0, 18)}…` : text || "—";
}
function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function EvidencePage() {
  const [params, setParams] = useSearchParams();
  const experimentsQuery = useQuery({ queryKey: ["experiments"], queryFn: api.experiments, refetchInterval: 15_000 });
  const [experimentId, setExperimentId] = useState(() => params.get("experiment") ?? "");
  const [runId, setRunId] = useState(() => params.get("run") ?? "");
  const [tab, setTab] = useState<TabId>("provenance");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [forceCase, setForceCase] = useState(false);
  const [forkSeq, setForkSeq] = useState("");
  const [compareRunId, setCompareRunId] = useState("");
  const [preflightText, setPreflightText] = useState(
    '[\n  { "tool": "read_file", "args": { "path": "README.md" } },\n  { "tool": "shell", "args": { "command": "git status --short" } }\n]'
  );

  const experiments = experimentsQuery.data?.experiments ?? [];
  const detailQuery = useQuery({
    queryKey: ["experiment", experimentId],
    queryFn: () => api.experiment(experimentId),
    enabled: experimentId.length > 0
  });
  const runs = detailQuery.data?.runs ?? [];
  const effectiveRunId = runId || runs[0]?.id || "";
  const selectedRun = runs.find((run) => run.id === effectiveRunId) ?? null;
  const taskId = selectedRun?.hearthTaskId ?? "";

  const provenanceQuery = useQuery({
    queryKey: ["evidence-provenance", taskId],
    queryFn: () => api.evidenceProvenance(taskId),
    enabled: taskId.length > 0 && tab === "provenance"
  });
  const costQuery = useQuery({
    queryKey: ["evidence-cost", taskId],
    queryFn: () => api.evidenceCost(taskId),
    enabled: taskId.length > 0 && tab === "cost"
  });
  const policyQuery = useQuery({
    queryKey: ["evidence-policy", taskId],
    queryFn: () => api.evidencePolicy(taskId),
    enabled: taskId.length > 0 && tab === "policy"
  });
  const manifestQuery = useQuery({
    queryKey: ["evidence-runtime-manifest", effectiveRunId],
    queryFn: () => api.evidenceManifest(effectiveRunId),
    enabled: effectiveRunId.length > 0 && (tab === "manifest" || tab === "cost")
  });
  const compareManifestQuery = useQuery({
    queryKey: ["evidence-runtime-manifest", compareRunId],
    queryFn: () => api.evidenceManifest(compareRunId),
    enabled: tab === "manifest" && compareRunId.length > 0
  });
  const bundleQuery = useQuery({
    queryKey: ["evidence-bundle", effectiveRunId, taskId],
    queryFn: () => api.evidenceBundle(effectiveRunId, taskId || undefined),
    enabled: effectiveRunId.length > 0 && tab === "failure"
  });
  const failureCasesQuery = useQuery({ queryKey: ["failure-cases"], queryFn: api.failureCases, enabled: tab === "failure" });
  const variantsQuery = useQuery({ queryKey: ["variants"], queryFn: api.variants, enabled: tab === "variants" });
  const variantMetricsQuery = useQuery({ queryKey: ["variant-metrics"], queryFn: api.variantMetrics, enabled: tab === "variants" });
  const experimentManifestQuery = useQuery({
    queryKey: ["experiment-manifest", experimentId],
    queryFn: () => api.evidenceExperimentManifest(experimentId),
    enabled: experimentId.length > 0 && tab === "manifest"
  });

  const chains = list(record(provenanceQuery.data).chains);
  const graph = record(record(provenanceQuery.data).graph);
  const cost = record(costQuery.data);
  const policy = record(policyQuery.data);
  const runtimeManifest = record(record(manifestQuery.data).manifest);
  const runtimeCompareManifest = record(record(compareManifestQuery.data).manifest);
  const failureCases = list(record(failureCasesQuery.data).cases);

  const manifestRows = useMemo(() => {
    if (!compareRunId) return [];
    const rows: Array<{ field: string; left: string; right: string; changed: boolean }> = [];
    const push = (field: string, left: unknown, right: unknown) => {
      const leftText = valueText(left);
      const rightText = valueText(right);
      rows.push({ field, left: leftText, right: rightText, changed: leftText !== rightText });
    };
    push("harnessVariantId", record(runtimeManifest.variant).harnessVariantId, record(runtimeCompareManifest.variant).harnessVariantId);
    push("variant digest", record(runtimeManifest.variant).digest, record(runtimeCompareManifest.variant).digest);
    push("model", record(runtimeManifest.runtime).model, record(runtimeCompareManifest.runtime).model);
    push("executor", record(runtimeManifest.executor).id, record(runtimeCompareManifest.executor).id);
    push("mode", record(runtimeManifest.runtime).mode, record(runtimeCompareManifest.runtime).mode);
    push("fingerprint", runtimeManifest.compatibilityFingerprint, runtimeCompareManifest.compatibilityFingerprint);
    push("harness", runtimeManifest.harness, runtimeCompareManifest.harness);
    return rows;
  }, [runtimeManifest, runtimeCompareManifest, compareRunId]);

  function selectExperiment(id: string) {
    setExperimentId(id);
    setRunId("");
    setCompareRunId("");
    setNotice(null);
    const next = new URLSearchParams(params);
    if (id) next.set("experiment", id);
    else next.delete("experiment");
    next.delete("run");
    setParams(next, { replace: true });
  }
  function selectRun(id: string) {
    setRunId(id);
    const next = new URLSearchParams(params);
    if (id) next.set("run", id);
    else next.delete("run");
    setParams(next, { replace: true });
  }

  async function replay() {
    if (!effectiveRunId) return;
    setBusy("replay");
    setNotice(null);
    try {
      const result = await api.evidenceReplay({ runId: effectiveRunId, mode: "strict_replay" });
      const report = record(record(result).report ?? result);
      setNotice({ tone: "ok", text: `Replay 完成：${valueText(record(report.divergence).kind, "no_divergence")}` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function fork() {
    if (!effectiveRunId) return;
    setBusy("fork");
    setNotice(null);
    try {
      const seq = Number.parseInt(forkSeq, 10);
      const result = await api.evidenceFork({ runId: effectiveRunId, ...(Number.isFinite(seq) ? { checkpointSeq: seq } : {}) });
      const child = record(result).childRunId ?? record(result).runId ?? record(record(result).fork).childRunId;
      setNotice({ tone: "ok", text: `已分叉：${valueText(child, "新运行已创建")}` });
      await detailQuery.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function preflight() {
    if (!taskId) return;
    setBusy("preflight");
    setNotice(null);
    try {
      const parsed = JSON.parse(preflightText) as unknown;
      if (!Array.isArray(parsed)) throw new Error("动作列表必须是 JSON 数组");
      const result = await api.evidencePolicyPreflight({ taskId, actions: parsed as JsonRecord[] });
      setNotice({ tone: "ok", text: `Preflight 完成：${valueText(record(result).decision ?? result, "已生成")}` });
      await policyQuery.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function compileFailure() {
    if (!effectiveRunId) return;
    setBusy("failure");
    setNotice(null);
    try {
      const result = await api.compileFailureFromRun({
        runId: effectiveRunId,
        ...(taskId ? { taskId } : {}),
        force: forceCase
      });
      setNotice({ tone: "ok", text: `已从失败现场生成回归 Case：${valueText(record(result.manifest).id, valueText(record(result).id))}` });
      await failureCasesQuery.refetch();
      await detailQuery.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page evidence-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Evidence Console</p>
          <h1>证据控制台</h1>
          <p>统一查看 OS Runtime Manifest、产物来源链、Replay 分叉、Policy 决策、USD 成本与失败回归闭环。</p>
        </div>
        <button className="button" onClick={() => {
          void detailQuery.refetch();
          void provenanceQuery.refetch();
          void costQuery.refetch();
          void policyQuery.refetch();
          void failureCasesQuery.refetch();
        }}>
          <RefreshCw size={15} /> 刷新
        </button>
      </header>

      <section className="panel evidence-picker">
        <label className="field">
          <span>实验</span>
          <select value={experimentId} onChange={(event) => selectExperiment(event.target.value)}>
            <option value="">选择实验…</option>
            {experiments.slice(0, 60).map((experiment) => (
              <option key={experiment.id} value={experiment.id}>{experiment.name} · {experiment.status}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>运行</span>
          <select value={effectiveRunId} onChange={(event) => selectRun(event.target.value)} disabled={runs.length === 0}>
            <option value="">{runs.length === 0 ? "暂无运行" : "选择运行…"}</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>{run.caseKey} · {run.status} · {run.id.slice(0, 10)}</option>
            ))}
          </select>
        </label>
        {selectedRun && (
          <div className="evidence-run-meta">
            <span className={`status-pill ${selectedRun.status}`}>{selectedRun.status}</span>
            <span className="muted-copy">task {selectedRun.hearthTaskId ?? "未关联"}</span>
          </div>
        )}
      </section>

      {notice && <p className={`evidence-notice ${notice.tone}`}>{notice.text}</p>}

      {experimentId.length === 0 ? (
        <div className="panel evidence-empty">
          <FlaskConical size={28} />
          <h2>选择一个实验</h2>
          <p>证据页复用真实 OS evidence API，只展示落库的 Manifest、Provenance、Policy 决策与成本记录。</p>
        </div>
      ) : (
        <>
          <section className="evidence-metrics">
            <Metric label="运行" value={runs.length} hint={`${runs.filter((run) => run.status === "passed").length} 通过`} />
            <Metric label="产物来源链" value={chains.length} hint="完整 provenance" />
            <Metric label="USD 记录" value={list(cost.entries).length} hint="真实计价" />
            <Metric label="失败 Case" value={failureCases.length} hint="可回归" />
          </section>

          <nav className="evidence-tabs">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={`evidence-tab${tab === item.id ? " is-active" : ""}`} onClick={() => setTab(item.id)}>
                  <Icon size={15} /> {item.label}
                </button>
              );
            })}
          </nav>

          {tab === "provenance" && (
            <section className="evidence-stack">
              <div className="panel">
                <SectionTitle title="产物来源链" hint={`${chains.length} 个产物`} />
                {!taskId ? <p className="muted-copy">该运行没有关联 OS 任务，无法读取 provenance。</p> : provenanceQuery.isPending ? <Loading /> : chains.length === 0 ? (
                  <p className="muted-copy">该任务还没有 provenance 记录。</p>
                ) : (
                  <div className="evidence-chain-list">
                    {chains.map((chain) => {
                      const item = record(chain);
                      const completeness = record(item.completeness);
                      return (
                        <article key={valueText(item.artifactId)} className="evidence-chain">
                          <div className="evidence-chain-head">
                            <strong>{valueText(item.relativePath ?? item.artifactId)}</strong>
                            <span className={`tag ${completeness.status === "complete" ? "ok" : "warn"}`}>{valueText(completeness.status)}</span>
                          </div>
                          <div className="evidence-chain-meta">
                            <span>sha256 {short(item.sha256)}</span>
                            <span>{list(item.sources).length} 个来源</span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
                <SectionTitle title="Artifact Graph" hint="节点与依赖边" />
                <pre className="evidence-json">{pretty(graph)}</pre>
              </div>
            </section>
          )}

          {tab === "manifest" && (
            <section className="evidence-stack">
              <div className="panel">
                <SectionTitle title="Runtime Manifest 差异" hint="两条运行的真实 Manifest 对比" />
                <div className="evidence-inline">
                  <label className="field">
                    <span>当前运行</span>
                    <select value={effectiveRunId} onChange={(event) => selectRun(event.target.value)}>
                      {runs.map((run) => <option key={run.id} value={run.id}>{run.caseKey} · {run.id.slice(0, 10)}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>对比运行</span>
                    <select value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)}>
                      <option value="">选择基线…</option>
                      {runs.filter((run) => run.id !== effectiveRunId).map((run) => (
                        <option key={run.id} value={run.id}>{run.caseKey} · {run.status} · {run.id.slice(0, 10)}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {compareRunId.length === 0 ? <p className="muted-copy">选择基线运行后显示差异。</p> : (
                  <table className="evidence-table">
                    <thead><tr><th>字段</th><th>当前</th><th>对比</th></tr></thead>
                    <tbody>
                      {manifestRows.map((row) => (
                        <tr key={row.field} className={row.changed ? "changed" : ""}>
                          <td>{row.field}</td><td>{row.left}</td><td>{row.right}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <SectionTitle title="Experiment Manifest" hint="实验级冻结配置" />
                <pre className="evidence-json">{pretty(experimentManifestQuery.data ?? {})}</pre>
              </div>
            </section>
          )}

          {tab === "replay" && (
            <section className="evidence-stack">
              <div className="panel">
                <SectionTitle title="重放与检查点分叉" hint="从 cassette 重放整条运行，或从检查点创建分支。" />
                <div className="evidence-inline">
                  <button className="button primary" disabled={!effectiveRunId || busy !== null} onClick={() => void replay()}>
                    {busy === "replay" ? <Loader2 size={15} className="spin" /> : <Play size={15} />} Strict Replay
                  </button>
                  <label className="field">
                    <span>检查点序号</span>
                    <input value={forkSeq} placeholder="可选" inputMode="numeric" onChange={(event) => setForkSeq(event.target.value)} />
                  </label>
                  <button className="button" disabled={!effectiveRunId || busy !== null} onClick={() => void fork()}>
                    {busy === "fork" ? <Loader2 size={15} className="spin" /> : <GitBranch size={15} />} 首次分叉
                  </button>
                </div>
                <SectionTitle title="Runtime Manifest" hint="本次 replay 的输入基线" />
                <pre className="evidence-json">{pretty(runtimeManifest)}</pre>
              </div>
            </section>
          )}

          {tab === "policy" && (
            <section className="evidence-stack">
              <div className="panel">
                <SectionTitle title="Policy Preflight" hint="审批前预演策略结果" />
                <label className="field">
                  <span>动作列表（JSON）</span>
                  <textarea rows={8} value={preflightText} onChange={(event) => setPreflightText(event.target.value)} />
                </label>
                <button className="button primary" disabled={!taskId || busy !== null} onClick={() => void preflight()}>
                  {busy === "preflight" ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} 运行 Preflight
                </button>
              </div>
              <div className="panel">
                <SectionTitle title="真实 Policy 决策" hint="来自 OS 审批前决策记录" />
                {policyQuery.isPending ? <Loading /> : <pre className="evidence-json">{pretty(policy)}</pre>}
              </div>
            </section>
          )}

          {tab === "cost" && (
            <section className="evidence-stack">
              <div className="evidence-metrics compact">
                <Metric label="USD 记录" value={list(cost.entries).length} hint="输入/输出 token 计价" />
                <Metric label="预算" value={list(cost.budgets).length} hint="硬上限" />
                <Metric label="降级" value={list(cost.degradations).length} hint="单调阶梯" />
              </div>
              <div className="panel">
                <SectionTitle title="成本与降级视图" hint="来自 /api/cost/tasks/:taskId" />
                {costQuery.isPending ? <Loading /> : <pre className="evidence-json">{pretty(costQuery.data ?? {})}</pre>}
                <SectionTitle title="Manifest 中的预算快照" hint="实际生效值" />
                <pre className="evidence-json">{pretty(record(runtimeManifest.budget))}</pre>
              </div>
            </section>
          )}

          {tab === "failure" && (
            <section className="evidence-stack">
              <div className="panel">
                <SectionTitle title="从失败现场生成回归 Case" hint="直接读取 OS evidence bundle，不需要手工填写 title/goal/输入/产物" />
                <p className="muted-copy">
                  当前运行：{effectiveRunId || "未选择"} · 状态 {selectedRun?.status ?? "—"} · 任务 {taskId || "未关联"}
                </p>
                <label className="checkbox-row">
                  <input type="checkbox" checked={forceCase} onChange={(event) => setForceCase(event.target.checked)} />
                  <span>非失败运行也强制编译（force）</span>
                </label>
                <div className="evidence-inline">
                  <button className="button primary" disabled={!effectiveRunId || busy !== null} onClick={() => void compileFailure()}>
                    {busy === "failure" ? <Loader2 size={15} className="spin" /> : <AlertTriangle size={15} />} 一键生成 Failure Case
                  </button>
                  <button className="button" disabled={effectiveRunId.length === 0} onClick={() => void bundleQuery.refetch()}>
                    <RefreshCw size={15} /> 读取 Bundle
                  </button>
                </div>
                <SectionTitle title="自动装载的失败现场" hint="OS task/runs/artifacts" />
                <pre className="evidence-json">{pretty(bundleQuery.data ?? {})}</pre>
              </div>
              <div className="panel">
                <SectionTitle title="已编译的 Failure Cases" hint={`${failureCases.length} 个`} />
                {failureCases.length === 0 ? <p className="muted-copy">还没有编译出的回归 Case。</p> : (
                  <div className="evidence-case-list">
                    {failureCases.slice(-10).reverse().map((item) => {
                      const entry = record(item);
                      return (
                        <article key={valueText(entry.id)} className="evidence-case">
                          <CheckCircle2 size={15} />
                          <div>
                            <strong>{valueText(record(record(entry.payload).manifest).title, valueText(entry.id))}</strong>
                            <span className="muted-copy">{valueText(entry.state)} · {valueText(entry.sourceRunId)}</span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === "variants" && (
            <section className="evidence-stack">
              <div className="panel">
                <SectionTitle title="Harness Variant Policy Lab" hint="任务级变体覆盖 Runtime 参数" />
                <div className="variant-grid">
                  {list(record(variantsQuery.data).variants).map((item) => {
                    const variant = record(item);
                    return (
                      <article key={valueText(variant.id)} className="variant-card">
                        <div className="evidence-chain-head">
                          <strong>{valueText(variant.label ?? variant.id)}</strong>
                          <span className="tag">{valueText(variant.id)}</span>
                        </div>
                        <p className="muted-copy">{valueText(variant.description)}</p>
                        <pre className="evidence-json small">{pretty(variant.overrides ?? {})}</pre>
                      </article>
                    );
                  })}
                </div>
              </div>
              <div className="panel">
                <SectionTitle title="变体指标" hint="成功率 / 成本 / 延迟聚合" />
                <pre className="evidence-json">{pretty(variantMetricsQuery.data ?? {})}</pre>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="evidence-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}
function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="evidence-section-title">
      <h3>{title}</h3>
      {hint && <span className="muted-copy">{hint}</span>}
    </div>
  );
}
function Loading() {
  return <p className="muted-copy"><Loader2 size={15} className="spin" /> 正在读取证据…</p>;
}
