import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";

export function CalibrationPanel() {
  const report = useQuery({ queryKey: ["evaluation-calibration"], queryFn: api.calibration, staleTime: 60_000 });
  const data = report.data;
  const percent = (value: number | null) => value === null ? "—" : `${value}%`;
  const labels = { pass: "通过", fail: "未通过", unknown: "证据不足", grader_error: "检查器错误" };
  return <section className="panel page-stack" aria-labelledby="calibration-title">
    <h2 id="calibration-title">评分器校准</h2>
    <p>把检查器结论与样本预期逐一比较。误放过率 = 错误样本被判通过 / 错误样本数；误拒绝率 = 正确样本被判失败 / 正确样本数。</p>
    {report.isPending && <p role="status">正在运行校准…</p>}
    {report.error && <p role="alert">{report.error.message}</p>}
    <div><button className="button" type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>重新校准</button></div>
    {data && <>
      <p>{data.version} · {data.labelStatus === "seed_unreviewed" ? "种子样本，尚未经人工确认，不能当作真实准确率" : `人工标注：${data.reviewedBy}`} · {data.summary.total} 个样本</p>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>规则集</th><th>正确 / 错误样本</th><th>误放过</th><th>误拒绝</th><th>可判定覆盖率</th><th>检查器错误</th></tr></thead>
        <tbody>{data.groups.map(group => <tr key={group.id}><th scope="row">{group.title}</th><td>{group.positive} / {group.negative}</td><td>{group.falsePass} · {percent(group.falsePassRate)}</td><td>{group.falseFail} · {percent(group.falseFailRate)}</td><td>{percent(group.coverage)}</td><td>{group.graderError}</td></tr>)}</tbody>
      </table></div>
      <details><summary>查看全部样本与标注依据</summary><div className="table-wrap"><table className="data-table">
        <thead><tr><th>样本</th><th>预期</th><th>实际</th><th>标注依据 / 检查结果</th></tr></thead>
        <tbody>{data.rows.map(row => <tr key={row.id}><th scope="row">{row.id}</th><td>{labels[row.expected]}</td><td>{labels[row.actual]}{row.expected !== row.actual ? " · 不一致" : ""}</td><td>{row.rationale}{row.reasons.length > 0 && <p>{row.reasons.join("；")}</p>}</td></tr>)}</tbody>
      </table></div></details>
    </>}
  </section>;
}
