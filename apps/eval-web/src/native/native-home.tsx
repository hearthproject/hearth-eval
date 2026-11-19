import { useCallback, useEffect, useMemo, useState } from "react";
import {
  nativeApi,
  type NativeCaseSummary,
  type NativeProviderTestResult,
  type NativeProviderView
} from "./native-api.ts";

const PROVIDER_PRESETS = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { label: "自定义", baseUrl: "", model: "" }
];

const FAMILY_LABELS: Record<string, string> = {
  email: "邮件",
  calendar: "日程",
  documents: "文档",
  research: "研究",
  code: "代码",
  web: "网页",
  desktop: "桌面",
  "cross-app": "跨应用",
  operations: "运维闭环",
  memory: "记忆与技能"
};

const DIFFICULTY_LABELS: Record<string, string> = {
  normal: "常规",
  edge: "边界",
  failure: "故障",
  adversarial: "对抗"
};

type Phase = "idle" | "running" | "done" | "error";
type Step = 1 | 2 | 3;

export function NativeHome() {
  const [providers, setProviders] = useState<NativeProviderView[]>([]);
  const [cases, setCases] = useState<NativeCaseSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCase, setSelectedCase] = useState<string>("");
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [resultText, setResultText] = useState<string>("");
  const [errorText, setErrorText] = useState<string>("");

  const reload = useCallback(async () => {
    try {
      const [{ providers: list }, catalog] = await Promise.all([nativeApi.providers(), nativeApi.cases()]);
      setProviders(list);
      setCases(catalog.cases);
      setLoadError(null);
      setSelectedProvider((current) => (list.some((item) => item.id === current) ? current : list[0]?.id ?? ""));
      setSelectedCase((current) => current || catalog.cases[0]?.caseKey || "");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const registered = useMemo(() => providers.filter((provider) => provider.apiKeyHint !== null), [providers]);
  const activeProvider = providers.find((provider) => provider.id === selectedProvider) ?? null;
  const activeCase = cases.find((item) => item.caseKey === selectedCase) ?? null;
  const canRun = registered.length > 0 && Boolean(activeProvider?.apiKeyHint) && Boolean(activeCase);

  const currentStep: Step = registered.length === 0 ? 1 : !canRun ? 2 : 3;

  const run = useCallback(async () => {
    if (!selectedCase || !selectedProvider) return;
    setPhase("running");
    setErrorText("");
    setResultText([
      `任务：${selectedCase}`,
      `模型：${activeProvider?.name} · ${activeProvider?.model}`,
      "",
      "执行中：读取 case 输入 → 调模型 → 写产物 → 确定性评分…"
    ].join("\n"));
    try {
      const detail = await nativeApi.run({ caseId: selectedCase, providerId: selectedProvider });
      const { run: record } = detail;
      const lines = [
        `状态：${record.status}`,
        `得分：${record.score === null ? "未评分" : record.score.toFixed(1)}`,
        record.error ? `错误：${record.error}` : "",
        "",
        "评分明细：",
        ...detail.graders.map((grader) => `- [${grader.passed ? "✓" : "✗"}] ${grader.criterionId}：${grader.reason}`),
        "",
        `轨迹（${detail.trace?.events.length ?? 0} 条）：`
      ];
      for (const event of detail.trace?.events ?? []) {
        lines.push(`#${event.seq} ${event.type} ${JSON.stringify(event.payload).slice(0, 220)}`);
      }
      setResultText(lines.filter((line) => line !== "").join("\n"));
      setPhase("done");
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
      setPhase("error");
    }
  }, [selectedCase, selectedProvider, activeProvider]);

  return (
    <div className="native-shell">
      <header className="native-header">
        <h1>Hearth Eval · 原生评测</h1>
        <p>用你自己的 LLM API Key 跑一条最小评测闭环：注册模型 → 选择任务 → 运行并看分。</p>
        <ol className="native-steps">
          <StepBadge index={1} title="注册 LLM" state={stepState(1, currentStep, registered.length > 0)} detail={registered.length > 0 ? `${registered.length} 个可用` : "未注册"} />
          <StepBadge index={2} title="选择任务" state={stepState(2, currentStep, Boolean(activeCase))} detail={activeCase?.caseKey ?? "未选择"} />
          <StepBadge index={3} title="运行并评分" state={stepState(3, currentStep, phase === "done")} detail={phase === "done" ? "已完成" : "待运行"} />
        </ol>
      </header>

      {loadError && <p className="native-error">加载失败：{loadError}</p>}

      <RegistrationPanel providers={providers} registered={registered} onChanged={reload} />

      <section className={`native-card ${registered.length === 0 ? "native-card-locked" : ""}`}>
        <h2>2. 选择任务</h2>
        {registered.length === 0 && <p className="native-muted">先在上一步注册一个 LLM，这一步才会解锁。</p>}
        <div className="native-row">
          <label>
            任务
            <select
              value={selectedCase}
              disabled={registered.length === 0}
              onChange={(event) => setSelectedCase(event.target.value)}
            >
              {cases.length === 0 && <option value="">（加载中）</option>}
              {groupByFamily(cases).map(([family, items]) => (
                <optgroup key={family} label={FAMILY_LABELS[family] ?? family}>
                  {items.map((item) => (
                    <option key={item.caseKey} value={item.caseKey}>
                      {item.caseKey} · {item.title}（{DIFFICULTY_LABELS[item.difficulty] ?? item.difficulty}）
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {activeCase && (
            <p className="native-meta">
              {FAMILY_LABELS[activeCase.family] ?? activeCase.family} · {activeCase.inputKinds.join(" + ")} 输入
              {activeCase.hasJudge ? " · 含评委评分项" : ""}
            </p>
          )}
        </div>
      </section>

      <section className={`native-card ${!canRun ? "native-card-locked" : ""}`}>
        <h2>3. 运行并评分</h2>
        <div className="native-row">
          <label>
            使用模型
            <select
              value={selectedProvider}
              disabled={registered.length === 0}
              onChange={(event) => setSelectedProvider(event.target.value)}
            >
              {registered.length === 0 && <option value="">（未注册）</option>}
              {registered.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} · {provider.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            任务
            <input readOnly value={activeCase ? `${activeCase.caseKey} · ${activeCase.title}` : "未选择"} />
          </label>
          <button className="native-primary" disabled={!canRun || phase === "running"} onClick={() => void run()}>
            {phase === "running" ? "运行中…" : "运行评测"}
          </button>
        </div>
        {errorText && <p className="native-error">{errorText}</p>}
        {resultText && <pre className="native-output">{resultText}</pre>}
      </section>
    </div>
  );
}

function StepBadge(props: { index: number; title: string; state: "done" | "current" | "todo"; detail: string }) {
  return (
    <li className={`native-step native-step-${props.state}`}>
      <span className="native-step-index">{props.state === "done" ? "✓" : props.index}</span>
      <span className="native-step-title">{props.title}</span>
      <span className="native-step-detail">{props.detail}</span>
    </li>
  );
}

function stepState(index: number, current: number, done: boolean): "done" | "current" | "todo" {
  if (done) return "done";
  if (index === current) return "current";
  return index < current ? "done" : "todo";
}

function RegistrationPanel(props: {
  providers: NativeProviderView[];
  registered: NativeProviderView[];
  onChanged: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: "",
    baseUrl: PROVIDER_PRESETS[0]!.baseUrl,
    model: PROVIDER_PRESETS[0]!.model,
    apiKey: "",
    maxSteps: 8
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [test, setTest] = useState<NativeProviderTestResult | null>(null);

  const register = async () => {
    setBusy(true);
    setMessage("");
    try {
      const saved = await nativeApi.saveProvider({
        name: form.name.trim() || form.model,
        kind: "openai-compatible",
        baseUrl: form.baseUrl,
        model: form.model.trim(),
        apiKey: form.apiKey,
        maxSteps: form.maxSteps
      });
      setForm((current) => ({ ...current, name: "", apiKey: "" }));
      setTest(null);
      setMessage(`已注册「${saved.name}」，Key 只存本机服务器，页面仅显示掩码。`);
      await props.onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    setTest(null);
    setMessage("");
    try {
      setTest(await nativeApi.testProvider({
        name: form.name,
        kind: "openai-compatible",
        baseUrl: form.baseUrl,
        model: form.model,
        apiKey: form.apiKey
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await nativeApi.deleteProvider(id);
      await props.onChanged();
    } finally {
      setBusy(false);
    }
  };

  const canRegister = Boolean(form.model.trim() && form.apiKey.trim() && form.baseUrl.trim());

  return (
    <section className="native-card">
      <h2>1. 注册 LLM</h2>
      <p className="native-muted">注册后这台评测服务器会保存 Base URL、模型名和 Key，后续运行直接选用，不用重复填写。</p>
      <div className="native-presets">
        {PROVIDER_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() =>
              setForm((current) => ({
                ...current,
                baseUrl: preset.baseUrl || current.baseUrl,
                model: preset.model || current.model
              }))
            }
          >
            {preset.label}
          </button>
        ))}
      </div>
      <div className="native-row">
        <label>
          名称
          <input
            value={form.name}
            placeholder="例如 DeepSeek-评测"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          Base URL
          <input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        </label>
        <label>
          模型
          <input
            value={form.model}
            placeholder="deepseek-chat"
            onChange={(event) => setForm({ ...form, model: event.target.value })}
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            value={form.apiKey}
            placeholder="sk-…"
            autoComplete="off"
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
          />
        </label>
        <label className="native-narrow">
          最大步数
          <input
            type="number"
            min={1}
            max={40}
            value={form.maxSteps}
            onChange={(event) => setForm({ ...form, maxSteps: Number(event.target.value) || 8 })}
          />
        </label>
      </div>
      <div className="native-row native-actions">
        <button onClick={() => void testConnection()} disabled={busy || !form.apiKey.trim()}>
          测试连接
        </button>
        <button className="native-primary" onClick={() => void register()} disabled={busy || !canRegister}>
          注册模型
        </button>
      </div>
      {message && <p className="native-muted">{message}</p>}
      {test && (
        <p className={test.ok ? "native-ok" : "native-error"}>
          {test.ok ? "✓" : "✗"} {test.message}（{test.latencyMs}ms · {test.baseUrl}）
        </p>
      )}
      {props.providers.length > 0 && (
        <table className="native-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>模型</th>
              <th>Base URL</th>
              <th>Key</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.providers.map((provider) => (
              <tr key={provider.id}>
                <td>{provider.name}</td>
                <td>{provider.model}</td>
                <td className="native-ellipsis" title={provider.baseUrl}>{provider.baseUrl}</td>
                <td>{provider.apiKeyHint ?? "未配置"}</td>
                <td>
                  <span className={provider.apiKeyHint ? "native-badge-ok" : "native-badge-warn"}>
                    {provider.apiKeyHint ? "可用" : "缺 Key"}
                  </span>
                </td>
                <td>
                  <button className="native-link" disabled={busy} onClick={() => void remove(provider.id)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function groupByFamily(cases: NativeCaseSummary[]): Array<[string, NativeCaseSummary[]]> {
  const map = new Map<string, NativeCaseSummary[]>();
  for (const item of cases) map.set(item.family, [...(map.get(item.family) ?? []), item]);
  return [...map.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}
