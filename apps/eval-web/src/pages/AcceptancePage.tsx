import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AcceptanceDefaults, AcceptanceJob, SharedMemory } from "@hearth/eval-core";
import { AcceptanceReport } from "./AcceptanceReport.tsx";
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
  const [tab,setTab] = useState<"delivery"|"metrics">("delivery");
  const [metric,setMetric] = useState<Awaited<ReturnType<typeof api.verdictAccuracy>>>();
  const [phase,setPhase] = useState<"loading"|"done"|"idle"|"error">("loading");
  const [refresh,setRefresh] = useState(0);
  const signature = history.data?.filter(j=>["passed","failed","error","stopped","interrupted"].includes(j.status)).map(j=>j.id+j.status+(j.referenceVerdict??"")).join("|");
  useEffect(()=>{
    if(signature===undefined) return;
    let active=true;
    let hide:ReturnType<typeof setTimeout>;
    setPhase("loading");
    Promise.all([api.verdictAccuracy(),new Promise(resolve=>setTimeout(resolve,350))]).then(([value])=>{
      if(!active)return;
      setMetric(value);setPhase("done");
      hide=setTimeout(()=>setPhase("idle"),1500);
    }).catch(()=>{if(active)setPhase("error");});
    return ()=>{active=false;clearTimeout(hide);};
  },[signature,refresh]);
  const [marks,setMarks] = useState<Record<string,boolean>>({});
  const cases=(history.data ?? []).filter(j=>j.status==="passed" || j.status==="failed");
  const batch=useMutation({mutationFn:()=>api.submitAccuracy(cases.map(j=>({id:j.id,correct:marks[j.id] ?? (j.referenceVerdict===j.status)}))),onSuccess:async ()=>{
    await cache.invalidateQueries({queryKey:["acceptances"]});
    setMarks({});setRefresh(n=>n+1);
  }});
  const reference = useMutation({mutationFn:(verdict:"passed"|"failed")=>api.setReference(id,verdict),onSuccess:updated=>{
    cache.setQueryData(["acceptance",updated.id],updated);
    void cache.invalidateQueries({queryKey:["acceptances"]});
  }});
  const job = detail.data;
  const live = Boolean(job && ["running", "waiting_approval", "waiting_input"].includes(job.status));
  useEffect(() => {
    if (!id || !live) return;
    const stream = new EventSource(`/api/acceptance/${encodeURIComponent(id)}/events`);
    stream.onmessage = event => cache.setQueryData(["acceptance", id], JSON.parse(event.data));
    return () => stream.close();
  }, [id, live, cache]);
  return <div className="page-stack">
    <PageHeader title="交付验收" description="Hearth OS 生成 Markdown，交付到桌面后独立检查，将失败原因交回修复并复测。" />
    <nav className="accuracy-tabs" aria-label="交付验收视图">
      <button type="button" aria-pressed={tab==="delivery"} onClick={()=>setTab("delivery")}>执行与验收</button>
      <button type="button" aria-pressed={tab==="metrics"} onClick={()=>setTab("metrics")}>Verdict Accuracy <b>{metric?.total && metric.reviewed===metric.total ? (100*metric.correct/metric.total).toFixed(1)+"%" : "—"}</b>
        <span aria-live="polite" className={"metric-indicator "+phase} aria-label={phase==="loading"?"正在刷新":phase==="done"?"已刷新":undefined}>{phase==="done"?"✓":phase==="error"?"!":""}</span></button>
    </nav>
    {tab==="metrics" && <section className="acceptance-glass settings-stack"><h2>判断准确率</h2><p>Verdict Accuracy = 判断正确的案例数 ÷ 总案例数</p>
      {metric && <p>已确认正确 {metric.correct} · 已有最终判定 {metric.total} · 待标注参考结论 {metric.total-metric.reviewed}</p>}
      <h3>验收记录</h3>
      <small>勾选机器判断正确的任务。提交时，本页未勾选的任务计为判断错误，共 {cases.length} 个案例。</small>
      {history.error && <p role="alert">{history.error.message}</p>}
      {cases.map(j=><div className="accuracy-case" key={j.id}>
        <label><input type="checkbox" disabled={batch.isPending} checked={marks[j.id] ?? (j.referenceVerdict===j.status)} onChange={e=>setMarks({...marks,[j.id]:e.target.checked})}/><span>{j.input.fileName}</span><small>{new Date(j.createdAt).toLocaleString()}</small><b data-pass={j.status==="passed"}>{j.status==="passed"?"✓ 机器通过":"× 机器未通过"}</b></label>
        <div className="accuracy-preview"><div>{j.csvReport ? <CsvReport name={j.input.fileName} rows={j.csvReport.rows} verdict={j.status==="passed"?"PASS":"FAIL"} footer={j.error ?? j.targetPath}/> : <AcceptanceReport job={j}/>}</div></div>
      </div>)}
      <button className="button button-primary" disabled={!cases.length || batch.isPending} onClick={()=>batch.mutate()}>{batch.isPending?"正在提交…":"提交并计算准确率"}</button>
      {batch.data && <p role="status">本次准确率 {(100*batch.data.correct/batch.data.total).toFixed(1)}%（{batch.data.correct}/{batch.data.total}）</p>}
      {batch.error && <p role="alert">{batch.error.message}</p>}
      {phase==="error" && <button type="button" onClick={()=>setRefresh(n=>n+1)}>读取失败，重新刷新</button>}</section>}
    <section hidden={tab!=="delivery"} style={tab!=="delivery"?{display:"none"}:undefined} className="panel settings-stack">
      <SectionHeader title="桌面 Markdown 闭环" detail="执行 → 真实文件检查 → 最多一次修复 → 复测" />
      {defaults.isLoading && <LoadingState text="识别桌面目录" />}
      {defaults.error && <ErrorState error={defaults.error} onRetry={() => void defaults.refetch()} />}
      {defaults.data && <AcceptanceForm defaults={defaults.data} onCreated={newId => { setId(newId); void cache.invalidateQueries({ queryKey: ["acceptances"] }); }} />}
    </section>
    <section hidden={tab!=="delivery"} style={tab!=="delivery"?{display:"none"}:undefined} className="panel settings-stack">
      <label className="field-label">验收记录<select value={id} onChange={event => { setId(event.target.value); control.reset(); }}><option value="">选择一条记录</option>{history.data?.map(item => <option key={item.id} value={item.id}>{item.input.fileName} · {statusLabels[item.status]}</option>)}</select></label>
      {(history.error || detail.error || control.error) && <p role="alert">{history.error?.message ?? detail.error?.message ?? control.error?.message}</p>}
      {job && ["passed","failed"].includes(job.status) && <label>人工参考结论 <select value={job.referenceVerdict ?? ""} disabled={reference.isPending} onChange={e=>reference.mutate(e.target.value as "passed"|"failed")}><option value="" disabled>待标注</option><option value="passed">应当通过</option><option value="failed">应当失败</option></select></label>}
      {reference.error && <p role="alert">{reference.error.message}</p>}
      {job?.input.semanticRequirements && <AcceptanceReport job={job} />}
      {job?.csvReport && <CsvReport name={job.input.fileName} rows={job.csvReport.rows} verdict={live?"PENDING":job.status==="passed"?"PASS":job.status==="failed"?"FAIL":"INCONCLUSIVE"} footer={job.error ?? job.csvReport.directory ?? statusLabels[job.status]} />}
      {job && !job.csvReport && <>
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
  const [taskId, setTaskId] = useState("");
  const [artifactId, setArtifactId] = useState("");
  const tasks = useQuery({ queryKey: ["hearth-tasks"], queryFn: api.hearthTasks });
  const outputs = useQuery({ queryKey: ["hearth-outputs", taskId], queryFn: () => api.hearthOutputs(taskId), enabled: Boolean(taskId), refetchInterval: 5000 });
  const artifacts = outputs.data?.artifacts.filter(a => /\.(md|csv)$/i.test(a.name)) ?? [];
  const selected = artifacts.find(a => a.id === artifactId) ?? (!artifactId && artifacts.length === 1 ? artifacts[0] : undefined);
  const csvMode = Boolean(selected && /\.csv$/i.test(selected.name));
  const [fileName, setFileName] = useState(defaults.fileName);
  const [title, setTitle] = useState(defaults.title);
  const [required, setRequired] = useState(defaults.requiredText.join("\n"));
  const [repair, setRepair] = useState(true);
  const [useMemory, setUseMemory] = useState(false);
  const [memoryKey, setMemoryKey] = useState("hearth-eval");
  const [requirements, setRequirements] = useState("面向第一次使用的人，介绍产品定位、已实现功能和下一步计划。明确区分已有功能与计划，事实与共享上下文一致。");
  const [csvRequirements,setCsvRequirements] = useState("检查订单号是否唯一、金额是否有效，以及数据是否符合共享项目要求。");
  const memory = useQuery({ queryKey: ["acceptance-memory", memoryKey], queryFn: () => api.acceptanceMemory(memoryKey), enabled: useMemory && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(memoryKey), refetchInterval: useMemory ? 5000 : false });
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const start = useMutation({ mutationFn: () => api.startAcceptance({ requestId, fileName, title, requiredText: required.split(/\r?\n/).map(item => item.trim()).filter(Boolean), maxRepairs: repair ? 1 : 0,
    ...(selected && taskId ? { source: { taskId, artifactId: selected.id, name: selected.name } } : {}),
    ...(useMemory ? { memoryKey, memoryRevision: memory.data?.memory?.revision ?? 0, semanticRequirements: requirements } : {}) }), onSuccess: job => { onCreated(job.id); setRequestId(crypto.randomUUID()); } });
  const changed = () => { setRequestId(crypto.randomUUID()); start.reset(); };
  return <form className="settings-stack" onSubmit={event => { event.preventDefault(); if (!csvMode) start.mutate(); }}>
    <p>执行器：Hearth OS native · {defaults.hearthUrl}。请先启动 Hearth 并配置可用的聊天模型。</p>
    <label className="field-label">Hearth OS 任务<select value={taskId} disabled={start.isPending} onChange={e => {setTaskId(e.target.value); setArtifactId(""); setRequired(e.target.value ? "" : defaults.requiredText.join("\n")); changed();}}>
      <option value="">新建 Markdown 任务</option>{tasks.data?.map(t => <option key={t.id} value={t.id}>{t.title} · {t.status} · {t.id}</option>)}</select></label>
    <button type="button" className="button" onClick={() => void tasks.refetch()}>刷新任务</button>
    {tasks.error && <p role="alert">{tasks.error.message}</p>}
    {taskId && <><details><summary>原任务要求</summary>{outputs.data?.goal}</details>
      <label className="field-label">用于验收的 Markdown 或 CSV<select value={selected?.id ?? ""} onChange={e => {setArtifactId(e.target.value); changed();}}>
        <option value="">{artifacts.length ? "选择产物" : "等待已发布的 Markdown 或 CSV"}</option>{artifacts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {outputs.error && <p role="alert">{outputs.error.message}</p>}</>}
    {!csvMode && <>
    <code className="settings-path">桌面目录：{defaults.desktopRoot}</code>
    <div className="form-grid">
      <label className="field-label">桌面文件名（例如 项目介绍，自动补 .md）<input required maxLength={120} value={fileName} disabled={start.isPending} onChange={event => { setFileName(event.target.value); changed(); }} /></label>
      <label className="field-label">一级标题<input required maxLength={120} value={title} disabled={start.isPending} onChange={event => { setTitle(event.target.value); changed(); }} /></label>
      <label className="field-label full">必含内容（可选，每行一项，最多 8 项）<textarea rows={4} value={required} disabled={start.isPending} onChange={event => { setRequired(event.target.value); changed(); }} /></label>
    </div>
    </>}
    <label><input type="checkbox" checked={useMemory} disabled={start.isPending} onChange={event => { setUseMemory(event.target.checked); changed(); }} /> 使用共享记忆与语义评审</label>
    {useMemory && <div className="panel settings-stack">
      <label className="field-label">项目记忆标识<input value={memoryKey} maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" required disabled={start.isPending} onChange={event => { setMemoryKey(event.target.value); changed(); }} /></label>
      {memory.error && <p role="alert">{memory.error.message}</p>}
      {memory.isLoading && <LoadingState text="读取共享记忆" />}
      {memory.data && <MemoryEditor key={`${memoryKey}:${memory.data.memory?.revision ?? 0}`} memoryKey={memoryKey} memory={memory.data.memory} onSaved={() => { changed(); void memory.refetch(); }} />}
      <label className="field-label">本次内容要求<textarea required maxLength={500} rows={3} value={csvMode ? csvRequirements : requirements} disabled={start.isPending} onChange={event => { (csvMode ? setCsvRequirements : setRequirements)(event.target.value); changed(); }} /></label>
      <p className="muted-copy">启动时固定已保存的记忆版本，同时提供给 Hearth 和独立评委。语义评审会把上下文与文件内容发送到“系统 → 模型评委”配置的服务；评委不可用时不会视为通过。</p>
      {Boolean(memory.data?.outcomes.length) && <details><summary>共享验收记录（不自动改写事实记忆）</summary><ul>{memory.data?.outcomes.map(outcome => <li key={outcome.jobId}><button type="button" className="button" onClick={() => onCreated(outcome.jobId)}>{outcome.fileName} · {statusLabels[outcome.status]} · 记忆 v{outcome.revision}</button></li>)}</ul></details>}
    </div>}
    <label><input type="checkbox" checked={repair} disabled={start.isPending} onChange={event => { setRepair(event.target.checked); changed(); }} /> 首次验收不通过时，{csvMode ? "允许订单清洗工具按原要求修复并复验一次" : "允许 Hearth 按原要求自动修复一次"}</label>
    {csvMode && selected ? <OrderCsv key={JSON.stringify([selected.id,repair,useMemory,memoryKey,memory.data?.memory?.revision,csvRequirements])} taskId={taskId} artifact={selected} repair={repair} review={useMemory ? {memoryKey,revision:memory.data?.memory?.revision ?? 0,requirements:csvRequirements} : undefined} /> : <>
    <p className="muted-copy">{taskId ? "首轮直接使用选定任务已发布的 Markdown，" : "开始后调用 Hearth 模型生成文件，"}交付步骤将发布产物原样保存到此桌面路径，再由检查器读取验收。已有同名文件不会覆盖；修复只替换本次交付且未被外部修改的文件。每轮最多等待 10 分钟，审批仍在 Hearth 处理。</p>
    {start.error && <p role="alert">{start.error.message}</p>}
    <button className="button button-primary" type="submit" disabled={start.isPending || Boolean(taskId && !selected) || (useMemory && !memory.data?.memory)}>{start.isPending ? "正在提交…" : "开始执行与验收"}</button>
    </>}
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

function OrderCsv({taskId,artifact,repair,review}:{taskId:string;artifact:{id:string;name:string};repair:boolean;review:{memoryKey:string;revision:number;requirements:string}|undefined}) {
  const labels = useQuery({queryKey:["csv-labels",taskId,artifact.id],queryFn:()=>api.csvLabels(taskId,artifact),staleTime:Infinity,retry:false});
  const [idOverride,setId] = useState<string|null>(null), [amountOverride,setAmount] = useState<string|null>(null);
  const idColumn=idOverride ?? labels.data?.idColumn ?? "", amountColumn=amountOverride ?? labels.data?.amountColumn ?? "";
  type CsvRow = {id:string;title:string;state:"PENDING"|"PASS"|"FAIL"|"INCONCLUSIVE";detail:string};
  const [steps,setSteps]=useState<CsvRow[]>([]);
  const run = useMutation({mutationFn:async () => {
    setSteps([{id:"file",title:"输出文件存在且可读取",state:"PENDING",detail:artifact.name}]);
    const response=await fetch(`/api/acceptance/hearth/tasks/${encodeURIComponent(taskId)}/orders`,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/x-ndjson"},body:JSON.stringify({name:artifact.name,artifactId:artifact.id,idColumn,amountColumn,repair,review})});
    if (!response.ok) throw new Error((await response.json()).message ?? "验收请求失败");
    if (!response.body) throw new Error("无法读取验收记录");
    const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending="";
    try {
      while(true) {
        const {value,done}=await reader.read(); if(done) break;
        const lines=(pending+value).split("\n"); pending=lines.pop() ?? "";
        for(const line of lines) {
          const event=JSON.parse(line);
          if(event.error) throw new Error(event.error);
          if(event.row) setSteps(previous=>previous.some(item=>item.id===event.row.id) ? previous.map(item=>item.id===event.row.id ? event.row : item) : [...previous,event.row]);
          if(event.result) return event.result as Awaited<ReturnType<typeof api.cleanOrderCsv>>;
        }
      }
      throw new Error("验收记录连接中断");
    } finally {reader.releaseLock();}
  }});
  const result = run.data;
  const rows = steps.map(r=>run.isError && r.state==="PENDING" ? {...r,state:"INCONCLUSIVE" as const,detail:run.error.message} : r);
  const verdict = run.isPending ? "PENDING" : result ? "PASS" : rows.some(r=>r.state==="FAIL") ? "FAIL" : "INCONCLUSIVE";
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob(["\uFEFF",result.csv],{type:"text/csv;charset=utf-8"}));
    const a = document.createElement("a"); a.href=url; a.download=artifact.name.split("/").pop()!.replace(/\.csv$/i,"-cleaned.csv"); a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <section className="acceptance-glass settings-stack"><h2>{labels.data?.title ?? artifact.name}</h2>
    {labels.isLoading && <p role="status">正在根据 CSV 表头生成验收字段…</p>}
    {labels.error && <p role="alert">{labels.error.message} <button type="button" onClick={()=>void labels.refetch()}>重试</button></p>}
    {labels.data?.warning && <small>{labels.data.warning}</small>}
    {labels.data && [[labels.data.idLabel,idColumn,setId],[labels.data.amountLabel,amountColumn,setAmount]].map(([label,column,setter],index)=><label key={index}>{String(label)}<select value={String(column)} disabled={run.isPending} onChange={e=>{(setter as typeof setId)(e.target.value);run.reset();setSteps([]);}}><option value="">选择列</option>{labels.data!.headers.map((h,i)=><option key={i} value={h}>{h}</option>)}</select></label>)}
    <button className="button button-primary" type="button" disabled={run.isPending || Boolean(review && (!review.revision || !review.requirements.trim())) || !idColumn.trim() || !amountColumn.trim() || idColumn===amountColumn} onClick={()=>run.mutate()}>{run.isPending?"验收中…":"开始验收"}</button>
    {steps.length>0 && <CsvReport name={artifact.name} rows={rows} verdict={verdict} footer={run.error?.message ?? (result ? "总体验收通过 · "+result.directory : "正在验收 "+artifact.name)} />}
    {run.error && <p role="alert">{run.error.message}</p>}
    {result && <><strong>{result.repaired ? "修复后复验通过" : "首轮验收通过"} · 保留 {result.retained} 条，移除 {result.removed.length} 条</strong>
      <p>验收报告.md 和清洗后订单.csv 已保存至 <code>{result.directory}</code></p>
      {result.review && <p>语义评审通过 · {result.review}</p>}
      {result.removed.length>0 && <details><summary>查看移除原因</summary><ul>{result.removed.slice(0,100).map(r=><li key={r.record}>第 {r.record} 条 · {r.id || "空订单号"} · {r.reason}</li>)}</ul>{result.removed.length>100 && "仅展示前 100 条"}</details>}
      <button className="button" type="button" onClick={download}>下载清洗后的 CSV</button></>}
  </section>;
}

function CsvReport({name,rows,verdict,footer}:{name:string;rows:import("@hearth/eval-core").CsvReportRow[];verdict:string;footer:string}) { return <section className="acceptance-glass csv-live-report" aria-label="CSV 实时验收报告">
      <header><div><h2>Hearth Eval — Acceptance Report</h2><small>{name}</small></div><strong data-state={verdict}>{verdict==="PENDING"?"验收中":verdict}</strong></header>
      <div className="report-counts">{(["PASS","FAIL","INCONCLUSIVE"] as const).map((state,index)=><div data-state={state} key={state}><small>{["通过","失败","无法判断"][index]}</small><b>{rows.filter(r=>r.state===state).length}</b></div>)}</div>
      <ul aria-live="polite">{rows.map(r=><li key={r.id} data-state={r.state}><span className="report-icon" aria-hidden="true">{({PASS:"✓",FAIL:"×",INCONCLUSIVE:"?",PENDING:""})[r.state]}</span><div><b>{r.title}</b><p>{r.detail}</p></div><small>{r.state==="PENDING"?"验收中":r.state}</small></li>)}</ul>
      <footer role="status">{footer}</footer>
    </section>; }
