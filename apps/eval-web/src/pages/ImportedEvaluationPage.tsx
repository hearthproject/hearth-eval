import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ImportedEvaluation, ImportedEvaluationInput } from "@hearth/eval-core";
import { api } from "../lib/api.ts";
import { CodexSetup } from "../components/CodexSetup.tsx";
import { CodexScoreHistory } from "../components/CodexScoreHistory.tsx";

const historyKey = ["imported-evaluations"];
const submissionSlots = ["A", "B"];

async function readSubmission(form: FormData, slot: string): Promise<ImportedEvaluationInput["submissions"][number]> {
  const file = form.get(`file-${slot}`);
  if (!(file instanceof File) || !file.size) throw new Error(`请上传 Agent ${slot} 的交付物。`);
  if (file.size > 160_000) throw new Error(`Agent ${slot} 的文件过大。`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new Error(`Agent ${slot} 的交付物必须是 UTF-8 文本。`);
  }
  if (text.length > 40_000 || !text.trim() || text.includes("\0")) {
    throw new Error(`Agent ${slot} 的交付物必须是非空文本，最多 40,000 字符。`);
  }
  return { agent: String(form.get(`agent-${slot}`)), version: String(form.get(`version-${slot}`)), fileName: file.name, text };
}

export function ImportedEvaluationPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [template, setTemplate] = useState<ImportedEvaluation>();
  const [formVersion, setFormVersion] = useState(0);
  const [credential, setCredential] = useState<{ id: string; token: string }>();
  const history = useQuery({ queryKey: historyKey, queryFn: api.importedEvaluations });
  const detail = useQuery({
    queryKey: [...historyKey, selectedId],
    queryFn: () => api.importedEvaluation(selectedId),
    enabled: Boolean(selectedId),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.agents && data.submissions.length < data.agents.length ? 2000 : false;
    }
  });
  const create = useMutation({
    mutationFn: async ({ form, automatic }: { form: FormData; automatic: boolean }) => {
      const task = {
        title: String(form.get("title")),
        prompt: String(form.get("prompt")),
        input: String(form.get("input")),
        expectedOutput: String(form.get("expectedOutput")),
        requiredText: String(form.get("requiredText")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      };
      if (automatic) return api.createImportedBatch({
        ...task,
        agents: submissionSlots.map((slot) => ({
          agent: String(form.get(`agent-${slot}`)), version: String(form.get(`version-${slot}`))
        }))
      });
      const submissions = await Promise.all(submissionSlots.map((slot) => readSubmission(form, slot)));
      return { evaluation: await api.createImportedEvaluation({ ...task, submissions }), token: undefined };
    },
    onSuccess: ({ evaluation, token }) => {
      setCredential(token ? { id: evaluation.id, token } : undefined);
      queryClient.setQueryData([...historyKey, evaluation.id], evaluation);
      setSelectedId(evaluation.id);
      void queryClient.invalidateQueries({ queryKey: historyKey, exact: true });
    }
  });
  const result = detail.data;
  const columns = (result?.agents ?? result?.submissions ?? []).map((agent, index) => {
    const submissionIndex = result?.agents
      ? result.submissions.findIndex((submission) => submission.slot === index + 1)
      : index;
    return { agent, grade: result?.results[submissionIndex] };
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    create.mutate({ form: new FormData(event.currentTarget), automatic: submitter?.id !== "manual-import" });
  }

  return (
    <div className="page-stack">
      <CodexScoreHistory />
      <CodexSetup />
      <section className="panel page-stack">
        <h1>外部 Agent 评测</h1>
        <p>创建自动评测批次，让两个 Agent 各自提交，或上传已经完成的交付物。每条文本检查等权计分。</p>
        <form key={formVersion} className="form-grid" onSubmit={submit}>
          <label className="field-label full">任务名称<input name="title" required maxLength={120} defaultValue={template?.title} /></label>
          <label className="field-label full">原始指令<textarea name="prompt" required maxLength={8000} rows={3} defaultValue={template?.prompt} /></label>
          <label className="field-label full">任务输入（可选）<textarea name="input" maxLength={40000} rows={3} defaultValue={template?.input} /></label>
          <label className="field-label full">预期交付物<textarea name="expectedOutput" required maxLength={2000} rows={2} defaultValue={template?.expectedOutput} /></label>
          <label className="field-label full">必须包含的文字（每行一条，最多 20 条）
            <textarea name="requiredText" required maxLength={4020} rows={4} defaultValue={template?.requiredText.join("\n")} />
          </label>
          {submissionSlots.map((slot) => (
            <section className="panel page-stack" key={slot} aria-label={`Agent ${slot}`}>
              <label className="field-label">Agent {slot} 名称<input name={`agent-${slot}`} required maxLength={100} /></label>
              <label className="field-label">版本（可选）<input name={`version-${slot}`} maxLength={100} /></label>
              <label className="field-label">交付物（仅手动上传时填写）
                <input name={`file-${slot}`} type="file" accept="text/*,.md,.json,.csv,.txt,.tsv,.yaml,.yml" />
              </label>
            </section>
          ))}
          <div className="full">
            <button className="button button-primary" disabled={create.isPending}>{create.isPending ? "正在保存…" : "创建自动评测批次"}</button>{" "}
            <button id="manual-import" className="button" disabled={create.isPending}>手动上传并评分</button>
          </div>
          {create.error && <p className="full" role="alert">{create.error.message}</p>}
        </form>
      </section>

      <section className="panel page-stack">
        <label className="field-label">历史评测
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">选择评测</option>
            {history.data?.map((item) => (
              <option key={item.id} value={item.id}>{item.title} · {new Date(item.createdAt).toLocaleString()}</option>
            ))}
          </select>
        </label>
        {history.error && <p role="alert">{history.error.message}</p>}
        {detail.isLoading && <p role="status">正在读取评测…</p>}
        {detail.error && <p role="alert">{detail.error.message}</p>}
        {result && (
          <>
            <h2>{result.title}</h2>
            {result.agents && <p role="status">已收到 {result.submissions.length} / {result.agents.length} 份交付物</p>}
            {credential?.id === result.id && (
              <details open>
                <summary>连接当前批次</summary>
                <p>请复制凭证。创建后只在当前页面显示一次。</p>
                <label className="field-label">评测 ID（HEARTH_EVAL_ID）<input value={credential.id} readOnly /></label>
                <label className="field-label">提交凭证（HEARTH_EVAL_TOKEN）<input value={credential.token} readOnly /></label>
                <p>为每个 Agent 设置 HEARTH_EVAL_SLOT（A = 1，B = 2）和 HEARTH_EVAL_FILE（交付物路径）。</p>
              </details>
            )}
            <details>
              <summary>任务说明</summary>
              <dl>
                <dt>原始指令</dt><dd style={{ whiteSpace: "pre-wrap" }}>{result.prompt}</dd>
                {result.input && <><dt>任务输入</dt><dd style={{ whiteSpace: "pre-wrap" }}>{result.input}</dd></>}
                <dt>预期交付物</dt><dd style={{ whiteSpace: "pre-wrap" }}>{result.expectedOutput}</dd>
              </dl>
            </details>
            <div>
              <button type="button" className="button" onClick={() => {
                setTemplate(result);
                setFormVersion((value) => value + 1);
                window.scrollTo({ top: 0 });
              }}>复用这道题</button>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th scope="col">检查项</th>
                  {columns.map(({ agent, grade }, index) => (
                    <th key={submissionSlots[index]} scope="col">
                      {agent.agent} {agent.version} · {grade ? `${grade.score}/100` : "待提交"}
                    </th>
                  ))}
                </tr></thead>
                <tbody>{result.requiredText.map((required, index) => (
                  <tr key={required}>
                    <th scope="row">{required}</th>
                    {columns.map(({ grade }, submissionIndex) => {
                      const check = grade?.checks[index];
                      return <td key={submissionSlots[submissionIndex]}>
                        {check ? `${check.passed ? "通过" : "缺失"} · ${check.evidence.join("、") || check.reason}` : "待提交"}
                      </td>;
                    })}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {result.submissions.map((submission, index) => (
              <details key={submission.slot ?? index}>
                <summary>{submission.agent} · {submission.fileName}</summary>
                {submission.metadata && (
                  <>
                    <dl>
                      <dt>耗时</dt><dd>{submission.metadata.durationMs == null ? "未提供" : `${submission.metadata.durationMs} ms`}</dd>
                      <dt>输入 Token</dt><dd>{submission.metadata.inputTokens ?? "未提供"}</dd>
                      <dt>输出 Token</dt><dd>{submission.metadata.outputTokens ?? "未提供"}</dd>
                    </dl>
                    {submission.metadata.log && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{submission.metadata.log}</pre>}
                  </>
                )}
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{submission.text}</pre>
              </details>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
