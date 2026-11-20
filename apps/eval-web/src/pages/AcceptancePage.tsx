import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AcceptanceDefaults, AcceptanceJob, SharedMemory } from "@hearth/eval-core";
import { api } from "../lib/api.ts";
import { ErrorState, LoadingState, PageHeader, SectionHeader } from "../components/ui.tsx";

const statusLabels: Record<AcceptanceJob["status"], string> = {
  running: "执行 / 验收中", waiting_approval: "等待 Hearth 审批", waiting_input: "等待 Hearth 补充信息",
  passed: "验收通过", failed: "验收未通过", error: "需要处理", stopped: "已停止", interrupted: "等待继续跟踪"
};

export function AcceptancePage() {
  const cache = useQueryClient();
  const [id, setId] = useState("");
  const defaults = useQuery({ queryKey: ["acceptance-defaults"], queryFn: api.acceptanceDefaults });
  const history = useQuery({ queryKey: ["acceptances"], queryFn: api.acceptances, refetchInterval: 3000 });
  const detail = useQuery({ queryKey: ["acceptance", id], queryFn: () => api.acceptance(id), enabled: Boolean(id), refetchInterval: 1500 });
  const control = useMutation({ mutationFn: (action: "stop" | "resume") => api.controlAcceptance(id, action), onSuccess: () => {
    void cache.invalidateQueries({ queryKey: ["acceptance", id] }); void cache.invalidateQueries({ queryKey: ["acceptances"] });
  } });
  const job = detail.data;
  return <div className="page-stack">
    <PageHeader title="交付验收" description="Hearth OS 生成 Markdown，交付到桌面后独立检查，将失败原因交回修复并复测。" />
    <section className="panel settings-stack">
      <SectionHeader title="桌面 Markdown 闭环" detail="执行 → 真实文件检查 → 最多一次修复 → 复测" />
      {defaults.isLoading && <LoadingState text="识别桌面目录" />}
      {defaults.error && <ErrorState error={defaults.error} onRetry={() => void defaults.refetch()} />}
      {defaults.data && <AcceptanceForm defaults={defaults.data} onCreated={newId => { setId(newId); void cache.invalidateQueries({ queryKey: ["acceptances"] }); }} />}
    </section>
    <section className="panel settings-stack">
      <label className="field-label">验收记录<select value={id} onChange={event => { setId(event.target.value); control.reset(); }}><option value="">选择一条记录</option>{history.data?.map(item => <option key={item.id} value={item.id}>{item.input.fileName} · {statusLabels[item.status]}</option>)}</select></label>
      {(history.error || detail.error || control.error) && <p role="alert">{history.error?.message ?? detail.error?.message ?? control.error?.message}</p>}
      {job && <>
        <div role="status"><strong>{statusLabels[job.status]}</strong> · 已提交 {job.attempts.length} 轮 / 最多 {1 + job.input.maxRepairs} 轮</div>
        <code className="settings-path">{job.targetPath}</code>
        {job.error && <p role="alert">{job.error}</p>}
        {job.contextSnapshot && <details className="settings-stack"><summary>本次共享上下文快照 · {job.contextSnapshot.key} · v{job.contextSnapshot.revision}</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{job.contextSnapshot.content}</pre>
          <p>内容要求：{job.input.semanticRequirements}</p>
          <code className="settings-path">SHA-256：{job.contextSnapshot.sha256}</code>
          <small>固定于 {new Date(job.contextSnapshot.capturedAt).toLocaleString()}；后续修改记忆不会改变本次执行或评审依据。</small>
        </details>}
        {["waiting_approval", "waiting_input"].includes(job.status) && <p>请到 Hearth 对应任务处理审批或补充信息。Eval 不会代替你批准，处理后会继续跟踪。</p>}
        <div className="settings-actions">
          {["interrupted", "error"].includes(job.status) && <button className="button" disabled={control.isPending || !job.attempts.at(-1)?.taskId} onClick={() => control.mutate("resume")}>继续跟踪已有任务</button>}
          {!["passed", "failed", "stopped"].includes(job.status) && <button className="button" disabled={control.isPending} onClick={() => control.mutate("stop")}>停止并取消执行</button>}
        </div>
        {job.attempts.map(attempt => <article key={attempt.number} className="panel settings-stack">
          <h3>第 {attempt.number} 轮 · {attempt.number === 1 ? "首次执行" : "根据验收反馈修复"}</h3>
          <p>执行器状态：{attempt.taskStatus} · {new Date(attempt.startedAt).toLocaleString()}</p>
          {attempt.taskId && <p>Hearth 任务 ID：<code>{attempt.taskId}</code> · <a href={`${job.executorUrl}/tasks/${encodeURIComponent(attempt.taskId)}`} target="_blank" rel="noreferrer">打开 Hearth 任务</a></p>}
          {attempt.feedback && <div><strong>交给执行器的修复依据</strong><pre style={{ whiteSpace: "pre-wrap" }}>{attempt.feedback}</pre></div>}
          {attempt.delivery && <p>产物交付：{attempt.delivery.deliveredAt ? "已原样保存到桌面" : "待确认"} · 来源产物 ID：<code>{attempt.delivery.artifactId}</code></p>}
          {attempt.semantic && <details><summary>语义评审 · {attempt.semantic.model} · {attempt.semantic.passed ? "通过" : "未通过"}</summary>
            {attempt.semantic.criteria.map(item => <div key={item.id}><p>{item.passed ? "✓" : "✗"} {item.id} · 置信度 {Math.round(item.confidence * 100)}% · {item.reason}</p>{item.evidence.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}</div>)}
            <code className="settings-path">评审提示词哈希：{attempt.semantic.promptHash}</code>
          </details>}
          {attempt.evidence && <>
            <strong className={attempt.evidence.passed ? "text-success" : "text-danger"}>{attempt.evidence.passed ? "文件符合本次验收要求" : "文件未满足验收要求"}</strong>
            <ul>{attempt.evidence.checks.map(check => <li key={check.id}>{check.passed ? "✓" : "✗"} {check.reason}</li>)}</ul>
            <small>检查时间：{new Date(attempt.evidence.checkedAt).toLocaleString()} · 大小：{attempt.evidence.bytes ?? "未知"} 字节</small>
            {attempt.evidence.sha256 && <code className="settings-path">SHA-256：{attempt.evidence.sha256}</code>}
          </>}
        </article>)}
        <p className="muted-copy">验收依据是检查时的实际文件，覆盖路径、UTF-8、标题和必含内容；不代表语义质量已全面评估。文件之后被修改，需要重新验收。</p>
      </>}
    </section>
  </div>;
}

function AcceptanceForm({ defaults, onCreated }: { defaults: AcceptanceDefaults; onCreated: (id: string) => void }) {
  const [fileName, setFileName] = useState(defaults.fileName);
  const [title, setTitle] = useState(defaults.title);
  const [required, setRequired] = useState(defaults.requiredText.join("\n"));
  const [repair, setRepair] = useState(true);
  const [useMemory, setUseMemory] = useState(false);
  const [memoryKey, setMemoryKey] = useState("hearth-eval");
  const [requirements, setRequirements] = useState("面向第一次使用的人，介绍产品定位、已实现功能和下一步计划。明确区分已有功能与计划，事实与共享上下文一致。");
  const memory = useQuery({ queryKey: ["acceptance-memory", memoryKey], queryFn: () => api.acceptanceMemory(memoryKey), enabled: useMemory && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(memoryKey), refetchInterval: useMemory ? 5000 : false });
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const start = useMutation({ mutationFn: () => api.startAcceptance({ requestId, fileName, title, requiredText: required.split(/\r?\n/).map(item => item.trim()).filter(Boolean), maxRepairs: repair ? 1 : 0,
    ...(useMemory ? { memoryKey, memoryRevision: memory.data?.memory?.revision ?? 0, semanticRequirements: requirements } : {}) }), onSuccess: job => { onCreated(job.id); setRequestId(crypto.randomUUID()); } });
  const changed = () => { setRequestId(crypto.randomUUID()); start.reset(); };
  return <form className="settings-stack" onSubmit={event => { event.preventDefault(); start.mutate(); }}>
    <p>执行器：Hearth OS native · {defaults.hearthUrl}。请先启动 Hearth 并配置可用的聊天模型。</p>
    <code className="settings-path">桌面目录：{defaults.desktopRoot}</code>
    <div className="form-grid">
      <label className="field-label">文件名<input required maxLength={120} value={fileName} disabled={start.isPending} onChange={event => { setFileName(event.target.value); changed(); }} /></label>
      <label className="field-label">一级标题<input required maxLength={120} value={title} disabled={start.isPending} onChange={event => { setTitle(event.target.value); changed(); }} /></label>
      <label className="field-label full">必含内容（每行一项，最多 8 项）<textarea rows={4} required value={required} disabled={start.isPending} onChange={event => { setRequired(event.target.value); changed(); }} /></label>
    </div>
    <label><input type="checkbox" checked={useMemory} disabled={start.isPending} onChange={event => { setUseMemory(event.target.checked); changed(); }} /> 使用共享记忆与语义评审</label>
    {useMemory && <div className="panel settings-stack">
      <label className="field-label">项目记忆标识<input value={memoryKey} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" required disabled={start.isPending} onChange={event => { setMemoryKey(event.target.value); changed(); }} /></label>
      {memory.error && <p role="alert">{memory.error.message}</p>}
      {memory.isLoading && <LoadingState text="读取共享记忆" />}
      {memory.data && <MemoryEditor key={`${memoryKey}:${memory.data.memory?.revision ?? 0}`} memoryKey={memoryKey} memory={memory.data.memory} onSaved={() => { changed(); void memory.refetch(); }} />}
      <label className="field-label">本次内容要求<textarea required maxLength={500} rows={3} value={requirements} disabled={start.isPending} onChange={event => { setRequirements(event.target.value); changed(); }} /></label>
      <p className="muted-copy">启动时固定已保存的记忆版本，同时提供给 Hearth 和独立评委。语义评审会把上下文与文件内容发送到“系统 → 模型评委”配置的服务；评委不可用时不会视为通过。</p>
      {Boolean(memory.data?.outcomes.length) && <details><summary>共享验收记录（不自动改写事实记忆）</summary><ul>{memory.data?.outcomes.map(outcome => <li key={outcome.jobId}><button type="button" className="button" onClick={() => onCreated(outcome.jobId)}>{outcome.fileName} · {statusLabels[outcome.status]} · 记忆 v{outcome.revision}</button></li>)}</ul></details>}
    </div>}
    <label><input type="checkbox" checked={repair} disabled={start.isPending} onChange={event => { setRepair(event.target.checked); changed(); }} /> 首次验收不通过时，允许 Hearth 按原要求自动修复一次</label>
    <p className="muted-copy">开始后调用 Hearth 模型在任务沙箱生成文件，交付步骤将发布产物原样保存到此桌面路径，再由检查器读取验收。已有同名文件不会覆盖；修复只替换本次交付且未被外部修改的文件。每轮最多等待 10 分钟，审批仍在 Hearth 处理。</p>
    {start.error && <p role="alert">{start.error.message}</p>}
    <button className="button button-primary" type="submit" disabled={start.isPending || (useMemory && !memory.data?.memory)}>{start.isPending ? "正在提交…" : "开始执行与验收"}</button>
  </form>;
}

function MemoryEditor({ memoryKey, memory, onSaved }: { memoryKey: string; memory: SharedMemory | null; onSaved: () => void }) {
  const [content, setContent] = useState(memory?.content ?? "");
  const save = useMutation({ mutationFn: () => api.saveAcceptanceMemory(memoryKey, content, memory?.revision ?? 0), onSuccess: onSaved });
  return <div className="settings-stack">
    <label className="field-label">共享项目事实与偏好<textarea rows={5} maxLength={1500} value={content} onChange={event => setContent(event.target.value)} placeholder="记录产品定位、已实现功能、计划与用户偏好。后续任务可以复用。" /></label>
    <div><button type="button" className="button" disabled={save.isPending || !content.trim()} onClick={() => save.mutate()}>{save.isPending ? "保存中…" : "保存共享记忆"}</button> · {memory ? `已保存 v${memory.revision}` : "尚未保存"}{content !== (memory?.content ?? "") && " · 有未保存内容，任务只使用已保存版本"}</div>
    {save.error && <p role="alert">{save.error.message}</p>}
  </div>;
}
