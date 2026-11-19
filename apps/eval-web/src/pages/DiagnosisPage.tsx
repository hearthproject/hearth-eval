import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { PageHeader } from "../components/ui.tsx";

const statuses = { running: "取证与分析中", waiting_approval: "等待复跑授权", waiting_rerun: "等待复跑结果", completed: "报告已完成", stopped: "已停止", error: "需要处理" };
const causes = { agent_regression: "Agent 退化", environment: "环境故障", grader: "评分器误判", unknown: "证据不足 / 待验证" };

export function DiagnosisPage() {
  const cache = useQueryClient();
  const [experimentId, setExperimentId] = useState("");
  const [budget, setBudget] = useState(0);
  const [id, setId] = useState("");
  const experiments = useQuery({ queryKey: ["experiments"], queryFn: api.experiments });
  const history = useQuery({ queryKey: ["diagnoses"], queryFn: api.diagnoses, refetchInterval: 3000 });
  const detail = useQuery({ queryKey: ["diagnosis", id], queryFn: () => api.diagnosis(id), enabled: Boolean(id), refetchInterval: 2000 });
  const create = useMutation({ mutationFn: () => api.startDiagnosis(experimentId, budget), onSuccess: job => { setId(job.id); void cache.invalidateQueries({ queryKey: ["diagnoses"] }); } });
  const control = useMutation({ mutationFn: ({ action, approved }: { action: "approve" | "resume" | "stop"; approved?: boolean }) => api.controlDiagnosis(id, action, approved),
    onSuccess: () => { void detail.refetch(); void history.refetch(); } });
  const job = detail.data;
  return <div className="page-stack">
    <PageHeader title="诊断 Agent" description="读取失败证据 → 提出判断 → 有限复跑 → 修正结论。使用本机已登录的 Codex CLI，每次最多 12 轮决策和 1 次离线复跑。" />
    <form className="panel page-stack" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <label className="field-label">目标实验<select required value={experimentId} onChange={e => setExperimentId(e.target.value)}><option value="">选择要诊断的实验</option>{experiments.data?.experiments.map(e => <option key={e.id} value={e.id}>{e.name} · {e.status}</option>)}</select></label>
      <label className="field-label">复跑授权<select value={budget} onChange={e => setBudget(Number(e.target.value))}><option value={0}>先取证，需要复跑时向我申请</option><option value={1}>允许最多 1 次离线复跑</option></select></label>
      <div><button className="button button-primary" disabled={!experimentId || create.isPending}>开始诊断</button></div>
      <p>诊断会把所选证据交给本机 Codex 使用的模型分析。Agent 只读取证据、创建授权的复跑，不修改原始评分。</p>
      {(create.error || experiments.error) && <p role="alert">{create.error?.message ?? experiments.error?.message}</p>}
    </form>
    <section className="panel page-stack">
      <label className="field-label">诊断记录<select value={id} onChange={e => { setId(e.target.value); control.reset(); }}><option value="">选择诊断</option>{history.data?.map(j => <option key={j.id} value={j.id}>{new Date(j.createdAt).toLocaleString()} · {statuses[j.status]}</option>)}</select></label>
      {(detail.error || history.error || control.error) && <p role="alert">{detail.error?.message ?? history.error?.message ?? control.error?.message}</p>}
      {job && <>
        <p role="status">{statuses[job.status]} · 决策 {job.steps}/{job.maxSteps} · 复跑 {job.rerunsUsed}/1</p>
        <Link className="text-link" to={`/experiments/${job.experimentId}`}>查看目标实验</Link>
        {job.rerunExperimentId && <Link className="text-link" to={`/experiments/${job.rerunExperimentId}`}>查看诊断复跑实验</Link>}
        {job.error && <p role="alert">{job.error}</p>}
        {job.status === "waiting_approval" && <div className="page-stack">
          <p>申请对运行 {job.pendingRunId} 离线复跑 1 次。{job.evidence.at(-1)?.reason}</p>
          <div><button className="button button-primary" disabled={control.isPending} onClick={() => control.mutate({ action: "approve", approved: true })}>允许此次复跑</button>{" "}<button className="button" disabled={control.isPending} onClick={() => control.mutate({ action: "approve", approved: false })}>拒绝，继续分析</button></div>
        </div>}
        <div>{["error", "stopped"].includes(job.status) && job.steps < job.maxSteps && <button className="button" disabled={control.isPending} onClick={() => control.mutate({ action: "resume" })}>从检查点继续</button>}
          {["running", "waiting_rerun", "waiting_approval"].includes(job.status) && <button className="button" disabled={control.isPending} onClick={() => control.mutate({ action: "stop" })}>停止诊断与复跑</button>}</div>
        {job.report && <article className="panel page-stack">
          <h2>诊断报告</h2><p>{job.report.summary}</p>
          {job.report.findings.map((finding, index) => <div key={index}><strong>{causes[finding.cause]}</strong><p>{finding.claim}</p><p>依据：{finding.evidenceIds.map(evidenceId => <a key={evidenceId} className="text-link" href={`#diagnosis-${job.id}-${evidenceId}`}>{evidenceId}{" "}</a>)}</p></div>)}
          <div><h3>新证据与判断修正</h3><p>{job.report.revision}</p></div>
          <div><h3>限制与待验证项</h3><ul>{job.report.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
        </article>}
        <h3>取证轨迹</h3>
        {job.evidence.map(e => <details className="panel" id={`diagnosis-${job.id}-${e.id}`} key={e.id}>
          <summary>{e.id} · {e.tool} · {e.error ? "失败" : e.reason}</summary>
          <p>{e.reason} · {e.target}{e.path && ` / ${e.path}`}</p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 360, overflow: "auto" }}>{e.data}</pre>
        </details>)}
      </>}
    </section>
  </div>;
}
