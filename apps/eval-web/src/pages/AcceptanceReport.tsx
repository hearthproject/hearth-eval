import type { AcceptanceJob } from "@hearth/eval-core/browser";
import "./acceptance-report.css";

const labels: Record<string,string> = {exists:"文件可读取",utf8:"UTF-8 编码",not_empty:"正文非空",heading:"一级标题",accuracy:"事实准确性",completeness:"内容要求",clarity:"表达与受众适配"};
type State = "PASS" | "FAIL" | "INCONCLUSIVE" | "PENDING";
type Row = {id:string; state:State; detail:string; quotes?:string[]};

export function AcceptanceReport({job}:{job:AcceptanceJob}) {
  const attempt = job.attempts.at(-1);
  const live = ["running","waiting_input","waiting_approval"].includes(job.status);
  const pending: State = live ? "PENDING" : "INCONCLUSIVE";
  const checks = attempt?.evidence?.checks ?? attempt?.fileChecks ?? [];
  const rows: Row[] = checks.filter(c=>!c.id.startsWith("semantic_")).map(c=>({id:c.id,state:c.passed?"PASS":"FAIL",detail:c.reason}));
  if (!rows.length) rows.push({id:"exists",state:pending,detail:job.input.fileName});
  for (const id of ["accuracy","completeness","clarity"]) {
    const item = attempt?.semantic?.criteria.find(c=>c.id===id);
    rows.push({id,state:item ? (item.passed?"PASS":"FAIL") : pending, detail:item?.reason ?? (id==="completeness" ? job.input.semanticRequirements ?? "" : ""), ...(item ? {quotes:item.evidence} : {})});
  }
  const verdict = job.status==="passed"?"PASS":job.status==="failed"?"FAIL":pending;
  const statuses = { PASS:"通过", FAIL:"失败", INCONCLUSIVE:"无法判断", PENDING:"进行中" };
  return <section className="acceptance-card" aria-label="实时验收报告">
    <header><div><h2>Hearth Eval · 验收报告</h2><small>{job.input.title} · 第 {attempt?.number ?? 1} 轮</small></div><strong data-state={verdict}>{statuses[verdict]}</strong></header>
    <div className="report-counts">{(["PASS","FAIL","INCONCLUSIVE"] as const).map(state=><div key={state} data-state={state}><small>{statuses[state]}</small><b>{rows.filter(r=>r.state===state).length}</b></div>)}</div>
    <ul>{rows.map(row=><li key={row.id} data-state={row.state}><span aria-hidden="true" className="report-icon">{({PASS:"✓",FAIL:"×",INCONCLUSIVE:"?",PENDING:""})[row.state]}</span>
      <div><b>{labels[row.id] ?? (row.id.startsWith("required_")?"必含文本 "+row.id.slice(9):"文件检查")}</b><p>{row.detail}</p>{Boolean(row.quotes?.length) && <details><summary>查看原文证据</summary>{row.quotes?.map((q,i)=><blockquote key={i}>{q}</blockquote>)}</details>}</div><small>{statuses[row.state]}</small></li>)}</ul>
    <footer role="status">{job.error ?? (job.status==="waiting_approval"?"等待 Hearth 批准写入文件":job.status==="waiting_input"?"等待 Hearth 补充信息":live?(attempt?.fileChecks?"模型正在核对正文和共享上下文":"正在等待交付与文件检查"):"验收结论 · "+statuses[verdict])}</footer>
  </section>;
}
