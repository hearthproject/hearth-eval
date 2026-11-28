import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DirectoryListing, JudgeSettingsInput, JudgeSettingsResponse, JudgeTestResult, StorageSettingsResponse } from "@hearth/eval-core/browser";
import { api } from "../lib/api.ts";
import { ErrorState, LoadingState, SectionHeader } from "./ui.tsx";

export function JudgeSettings() {
  const query = useQuery({ queryKey: ["judge-settings"], queryFn: api.judgeSettings });
  return <section className="panel" id="judge-settings">
    <SectionHeader title="LLM 状态与模型评委" detail="评测台独立配置，无需连接 Hearth" />
    {query.isLoading ? <LoadingState text="读取模型配置" /> : query.error ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : query.data && <JudgeForm initial={query.data} />}
  </section>;
}

function JudgeForm({ initial }: { initial: JudgeSettingsResponse }) {
  const cache = useQueryClient();
  const [editing, setEditing] = useState(!initial.configured);
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState<JudgeSettingsInput>({ providerName: initial.settings.providerName, protocol: "openai-chat", baseUrl: initial.settings.baseUrl, model: initial.settings.model, apiKey: "" });
  const [result, setResult] = useState<JudgeTestResult | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState("");
  const update = (key: keyof JudgeSettingsInput, value: string) => { setDraft({ ...draft, [key]: value }); setResult(null); setMessage(""); };
  const perform = async (action: "save" | "test") => {
    setBusy(action); setMessage(""); setResult(null);
    try {
      if (action === "test") {
        setResult(await api.testJudge(editing ? draft : {}));
      } else {
        const response = await api.saveJudgeSettings(draft);
        setSaved(response); setDraft({ ...draft, apiKey: "" }); setEditing(false);
        setMessage("配置已保存；后续评分使用此模型。请测试连接确认可用性。");
        await cache.invalidateQueries({ queryKey: ["system"] });
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };
  return <div className="settings-stack">
    <p className="muted-copy">{saved.configured ? `已配置 ${saved.settings.model}` : "尚未配置模型评委"} · {result ? (result.ok ? "连接测试通过" : "连接测试失败") : "连通性未确认"}</p>
    {editing && <div className="form-grid">
      <label className="field-label">配置名称<input value={draft.providerName ?? ""} onChange={(e) => update("providerName", e.target.value)} disabled={busy !== null} /></label>
      <label className="field-label">协议<input value="OpenAI 兼容（Chat Completions）" readOnly /></label>
      <label className="field-label">API 地址<input placeholder="https://api.example.com/v1" value={draft.baseUrl ?? ""} onChange={(e) => update("baseUrl", e.target.value)} disabled={busy !== null} /></label>
      <label className="field-label">模型名称<input value={draft.model ?? ""} onChange={(e) => update("model", e.target.value)} disabled={busy !== null} /></label>
      <label className="field-label full">API Key<input type="password" autoComplete="new-password" placeholder={saved.settings.hasApiKey ? "已保存，留空保持原密钥" : "填写 API Key"} value={draft.apiKey ?? ""} onChange={(e) => update("apiKey", e.target.value)} disabled={busy !== null} /></label>
    </div>}
    <div className="settings-actions">
      <button className="button" disabled={busy !== null} onClick={() => void perform("test")}>{busy === "test" ? "正在检测…" : editing ? "测试当前配置" : "确认 LLM 状态"}</button>
      {editing ? <>
        <button className="button primary" disabled={busy !== null || !draft.baseUrl?.trim() || !draft.model?.trim()} onClick={() => void perform("save")}>{busy === "save" ? "保存中…" : "保存评委配置"}</button>
        <button className="button" disabled={busy !== null} onClick={() => { setEditing(false); setDraft({ providerName: saved.settings.providerName, protocol: "openai-chat", baseUrl: saved.settings.baseUrl, model: saved.settings.model, apiKey: "" }); setResult(null); setMessage(""); }}>取消</button>
      </> : <button className="button" disabled={busy !== null} onClick={() => { setEditing(true); setResult(null); }}>更改配置</button>}
    </div>
    <small className="muted-copy">测试会发送一次短模型请求。草稿测试不会保存配置；未配置或调用失败时转人工复核。</small>
    {result && <p role="status" className={result.ok ? "text-success" : "text-danger"}>{result.ok ? "模型响应正常" : result.error ?? "连接失败"} · {result.elapsedMs ?? 0} ms{editing ? "（当前草稿）" : ""}</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}

export function StorageSettings() {
  const query = useQuery({ queryKey: ["storage-settings"], queryFn: api.storageSettings });
  return <section className="panel">
    <SectionHeader title="本地存储" detail="选择评测数据库与产物目录" />
    {query.isLoading ? <LoadingState text="读取目录配置" /> : query.error ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : query.data && <StorageForm initial={query.data} />}
  </section>;
}

function StorageForm({ initial }: { initial: StorageSettingsResponse }) {
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState(initial.next);
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState<"dataDir" | "artifactRoot" | null>(null);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const browse = async (path?: string) => {
    setBusy(true); setMessage("");
    try { const result = await api.directories(path); setListing(result); setLocation(result.path); }
    catch (error) { setListing(null); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setMessage("");
    try { const result = await api.saveStorageSettings(draft); setState(result); setDraft(result.next); setEditing(false); setPicker(null); setMessage(result.restartRequired ? "已保存，重启评测服务后生效。" : "配置已保存。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="settings-stack">
    <div className="form-grid">{(["dataDir", "artifactRoot"] as const).map((key) => <div className="field-label" key={key}>
      <strong>{key === "dataDir" ? "评测数据库目录" : "产物目录"}</strong>
      <code className="settings-path">当前：{state.current[key]}</code>
      {state.next[key] !== state.current[key] && <small>重启后：{state.next[key]}</small>}
      {editing && <><input aria-label={key === "dataDir" ? "评测数据库目录" : "产物目录"} value={draft[key]} disabled={busy || state.overrides[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
        <button className="button" disabled={busy || state.overrides[key]} onClick={() => { setPicker(key); setListing(null); setLocation(draft[key]); void browse(draft[key]); }}>选择目录</button></>}
      {state.overrides[key] && <small>由环境变量指定；修改环境变量并重启后生效。</small>}
    </div>)}</div>
    {picker && <div className="directory-picker" role="group" aria-label="目录选择器">
      <strong>选择{picker === "dataDir" ? "数据库目录" : "产物目录"}（评测服务所在电脑）</strong>
      <div className="settings-actions"><input aria-label="浏览目录路径" value={location} disabled={busy} onChange={(e) => setLocation(e.target.value)} /><button className="button" disabled={busy} onClick={() => void browse(location)}>打开路径</button><button className="button" disabled={busy} onClick={() => void browse()}>项目目录</button></div>
      {listing && <><div className="settings-actions"><button className="button" disabled={busy || listing.parent === listing.path} onClick={() => void browse(listing.parent)}>上一级</button><button className="button primary" disabled={busy} onClick={() => { setDraft({ ...draft, [picker]: listing.path }); setPicker(null); }}>使用此目录</button></div>
        <div className="directory-list">{listing.directories.map((entry) => <button className="button" key={entry.path} disabled={busy} onClick={() => void browse(entry.path)}>{entry.name}/</button>)}{listing.directories.length === 0 && <small>没有子目录，可以使用当前目录。</small>}</div></>}
      <button className="button" disabled={busy} onClick={() => setPicker(null)}>关闭选择器</button>
    </div>}
    <p className="muted-copy">数据库文件名为 eval.sqlite。请选择已有可写目录；保存后重启生效，不会自动迁移数据库、模型执行器配置或旧产物。使用 Hearth 执行器时，产物目录需与其配置保持一致。</p>
    {state.restartRequired && <p className="text-warning">有待生效的目录配置，请完成当前评测后重启服务。</p>}
    <div className="settings-actions">{editing ? <><button className="button primary" disabled={busy || picker !== null} onClick={() => void save()}>保存目录配置</button><button className="button" disabled={busy} onClick={() => { setEditing(false); setDraft(state.next); setPicker(null); setMessage(""); }}>取消</button></> : <button className="button" onClick={() => setEditing(true)}>选择配置</button>}</div>
    {message && <p role="status">{message}</p>}
  </div>;
}
