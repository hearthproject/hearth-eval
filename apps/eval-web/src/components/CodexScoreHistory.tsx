import { useQuery } from "@tanstack/react-query";
import { ScrambleTitle, SmoothDisclosure } from "./EvaluationMotion.tsx";
import { api } from "../lib/api.ts";

export function CodexScoreHistory() {
  const history = useQuery({
    queryKey: ["codex-scores", null],
    queryFn: () => api.codexScores(null),
    refetchInterval: 5000
  });

  return (
    <section className="panel page-stack" aria-labelledby="codex-score-history">
      <ScrambleTitle id="codex-score-history" text="Codex 评分记录" />
      <p>每条记录保留当时使用的规则和检查结果。<br />仅显示最近三条评分记录。总分为通过项占比乘以 100，再四舍五入。</p>
      {history.isPending && <p role="status">正在读取评分记录…</p>}
      {history.error && (
        <div role="alert">
          <p>{history.error.message}</p>
          <button className="button" type="button" onClick={() => void history.refetch()}>重试</button>
        </div>
      )}
      {history.data?.records.length === 0 && <p>暂无评分记录。配置插件后，完成一轮 Codex 对话即可在这里看到结果。</p>}
      {history.data?.records.slice(0, 3).map((record, index) => (
        <SmoothDisclosure key={record.id} defaultOpen={index === 0} summary={<>
            <time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time>
            {" · "}<strong>{record.score}/100</strong>
            {" · "}通过 {record.checks.filter((check) => check.passed).length}/{record.checks.length}
          </>}>
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
        </SmoothDisclosure>
      ))}
    </section>
  );
}
