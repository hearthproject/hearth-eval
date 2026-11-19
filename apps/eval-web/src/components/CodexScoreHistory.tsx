import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";

export function CodexScoreHistory() {
  const [before, setBefore] = useState<number | null>(null);
  const history = useQuery({
    queryKey: ["codex-scores", before],
    queryFn: () => api.codexScores(before),
    refetchInterval: before === null ? 5000 : false
  });
  const nextBefore = history.data?.nextBefore;

  return (
    <section className="panel page-stack" aria-labelledby="codex-score-history">
      <h2 id="codex-score-history">Codex 评分记录</h2>
      <p>每条记录保留当时使用的规则和检查结果。总分为通过项占比乘以 100，再四舍五入。</p>
      {history.isPending && <p role="status">正在读取评分记录…</p>}
      {history.error && (
        <div role="alert">
          <p>{history.error.message}</p>
          <button className="button" type="button" onClick={() => void history.refetch()}>重试</button>
        </div>
      )}
      {history.data?.records.length === 0 && <p>暂无评分记录。配置插件后，完成一轮 Codex 对话即可在这里看到结果。</p>}
      {history.data?.records.map((record, index) => (
        <details className="panel" key={record.id} open={index === 0 || undefined}>
          <summary>
            <time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time>
            {" · "}<strong>{record.score}/100</strong>
            {" · "}通过 {record.checks.filter((check) => check.passed).length}/{record.checks.length}
          </summary>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th scope="col">最终回复必须包含</th><th scope="col">结果</th><th scope="col">判定依据</th></tr></thead>
              <tbody>
                {record.checks.map((check) => (
                  <tr key={check.requiredText}>
                    <th scope="row">{check.requiredText}</th>
                    <td>{check.passed ? "通过" : "未通过"}</td>
                    <td>{check.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      {(before !== null || nextBefore != null) && (
        <div>
          {before !== null && <button className="button" type="button" onClick={() => setBefore(null)}>回到最新</button>}
          {" "}
          {nextBefore != null && (
            <button className="button" type="button" onClick={() => setBefore(nextBefore)}>更早的记录</button>
          )}
        </div>
      )}
    </section>
  );
}
