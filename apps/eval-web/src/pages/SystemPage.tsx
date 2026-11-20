import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  Gauge,
  RefreshCw,
  ShieldCheck,
  XCircle
} from "lucide-react";
import { api } from "../lib/api.ts";
import { executorLabel, formatDateTime } from "../lib/labels.ts";
import { ErrorState, KeyValue, LoadingState, MetricCard, PageHeader, SectionHeader } from "../components/ui.tsx";
import { JudgeSettings, StorageSettings } from "../components/SystemSettings.tsx";

export function SystemPage() {
  const query = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 10_000 });
  if (query.isLoading) return <LoadingState text="正在检查评测环境" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const system = query.data!;
  const readyExecutors = system.executors.filter((executor) => executor.canRun).length;

  return (
    <div className="page-stack system-page">
      <PageHeader
        title="系统状态"
        description="独立评测服务、LLM 模型评委、执行器和本地存储。Hearth 为可选接入。"
        actions={<button className="button" onClick={() => void query.refetch()}><RefreshCw size={15} /> 重新检查</button>}
      />

      <section className="system-banner ok">
        <span className="system-banner-icon"><CheckCircle2 size={23} /></span>
        <div><strong>评测服务在线</strong><span>可独立运行原生 LLM 评测与外部 Agent 评分</span></div>
        <small>检查于 {formatDateTime(system.generatedAt)}</small>
      </section>

      <section className="metric-grid">
        <MetricCard label="任务目录" value={system.catalogCases} detail={system.catalogIssues > 0 ? `${system.catalogIssues} 个目录问题` : "目录校验通过"} icon={<Database size={16} />} tone={system.catalogIssues > 0 ? "warning" : "neutral"} />
        <MetricCard label="可用执行器" value={`${readyExecutors} / ${system.executors.length}`} detail="原生 LLM 与可选 Hearth 执行器" icon={<Cpu size={16} />} tone={readyExecutors > 0 ? "success" : "warning"} />
        <MetricCard label="模型评委" value={system.judgeConfigured ? "已配置" : "未配置"} detail={system.judgeModel ?? "自动评分将回退到人工复核"} icon={<ShieldCheck size={16} />} tone={system.judgeConfigured ? "success" : "warning"} />
        <MetricCard label="运行 / 复核" value={`${system.runningExperiments} / ${system.pendingReviews}`} detail="进行中实验 / 待人工复核" icon={<Gauge size={16} />} tone={system.pendingReviews > 0 ? "warning" : "neutral"} />
      </section>

      <JudgeSettings />

      <div className="detail-grid">
        <section className="panel">
          <SectionHeader title="执行器" detail="原生 LLM 与可选接入" />
          <div className="system-executor-list">
            {system.executors.map((executor) => (
              <article className={`system-executor ${executor.canRun ? "ready" : "unavailable"}`} key={executor.id}>
                <span className="executor-icon"><Cpu size={16} /></span>
                <div><strong>{executorLabel(executor.id)}</strong><small>{executor.description}</small>{executor.issues.map((issue) => <em key={issue}>{issue}</em>)}</div>
                <span className={`ready-badge ${executor.canRun ? "ok" : "bad"}`}>{executor.canRun ? "可用" : "不可用"}</span>
                {executor.version && <code>{executor.version}</code>}
              </article>
            ))}
            {system.executors.length === 0 && <p className="muted-copy">还没有可用执行器，可前往 <a href="/native.html">原生 LLM 控制台</a> 添加模型配置。</p>}
          </div>
        </section>

        <section className="panel">
          <SectionHeader title="Hearth 接入（可选）" detail="仅用于评测 Hearth Agent 与白盒场景" />
          <div className="kv-stack">
            <KeyValue label="Hearth URL" mono>{system.hearthUrl}</KeyValue>
            <KeyValue label="Hearth 状态">{system.hearthReachable ? <span className="text-success">在线 · {system.hearthStatus}</span> : <span className="text-danger">离线</span>}</KeyValue>
            <KeyValue label="评委模型">{system.judgeModel ?? "未配置"}</KeyValue>
            <KeyValue label="评委状态">{system.judgeConfigured ? "已配置 · 请测试连接" : "仅确定性评分"}</KeyValue>
            <KeyValue label="评测版本">v{system.evalVersion}</KeyValue>
          </div>
          {!system.judgeConfigured && <div className="system-note warning"><AlertTriangle size={15} /><span>模型评委不可用时，judge 标准会触发人工复核，不会静默通过。</span></div>}
          {!system.hearthReachable && <p className="muted-copy">未接入 Hearth 不影响原生 LLM 评测与外部 Agent 评分。</p>}
        </section>
      </div>

      <StorageSettings />

      <section className="panel">
        <SectionHeader title="启动方式" detail="开发环境最终检查" />
        <div className="command-grid">
          <div><span>Hearth 主服务</span><code>cd ../hearth-os; npm run dev</code><small>Agent API · 127.0.0.1:4317</small></div>
          <div><span>评测服务</span><code>npm run dev:server</code><small>Eval API · 127.0.0.1:4318</small></div>
          <div><span>评测前端</span><code>npm run dev:web</code><small>Console · 127.0.0.1:5175</small></div>
          <div><span>生产构建</span><code>npm run build; npm start</code><small>评测服务直接托管 dist</small></div>
        </div>
      </section>
    </div>
  );
}
