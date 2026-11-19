import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";

function CopyConfig({ path, value }: { path: string; value: string }) {
  const [status, setStatus] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("已复制");
    } catch {
      setStatus("无法自动复制，请选中下方内容手动复制。");
    }
  }

  return (
    <div className="page-stack">
      <label className="field-label">
        <code>{path}</code>
        <textarea readOnly value={value} rows={Math.min(12, value.split("\n").length)} spellCheck={false} />
      </label>
      <div>
        <button type="button" className="button" onClick={() => void copy()}>复制配置</button>
        {" "}<span role="status">{status}</span>
      </div>
    </div>
  );
}

export function CodexSetup() {
  const setup = useQuery({ queryKey: ["codex-setup"], queryFn: api.codexSetup, staleTime: Infinity });
  const [description, setDescription] = useState("");
  const generated = useMutation({ mutationFn: api.generateCodexRules });
  const port = setup.data ? (JSON.parse(setup.data.rules) as { port?: number }).port : undefined;

  return (
    <section className="panel page-stack" aria-labelledby="codex-setup-heading">
      <h2 id="codex-setup-heading">在 Codex 对话里显示 Hearth 评分</h2>
      <p>在运行 Eval 的同一台电脑上配置一次。之后每轮结束时，Codex 会显示最终回复的文本检查分数。</p>
      <div className="page-stack">
        <h3>1. 安装 Hearth Eval 插件</h3>
        <p>如果 Plugins 中已有 Hearth Eval，直接配置评分规则。首次安装时，在 Hearth Eval 仓库根目录运行：</p>
        <pre>{"codex plugin marketplace add ./integrations/codex\ncodex plugin add hearth-eval@hearth-local"}</pre>
        <p>重新打开 Codex，在 Plugins 中确认 Hearth Eval 已启用。</p>
        {setup.isPending && <p role="status">正在读取本机配置…</p>}
        {setup.error && (
          <div role="alert">
            <p>无法读取配置。请确认 Eval 服务已启动或重启到最新代码。</p>
            <button type="button" className="button" onClick={() => void setup.refetch()}>重试</button>
          </div>
        )}
        <h3>2. 添加评分规则</h3>
        <p>在要评测的 Codex 项目根目录把配置保存为 <code>codex-eval.json</code>，使用 UTF-8 JSON。根目录没有该文件时，插件才读取旧位置 <code>.hearth/codex-eval.json</code>。</p>
        <ul>
          <li><code>requiredText</code> 必填。填写 1–20 条不重复的字符串，每条 1–200 字符，用双引号包住并用逗号隔开。</li>
          <li><code>port</code> 可选。仅在 Eval 使用自定义端口时填写，值为 1–65535 的整数。默认是 4318。</li>
          <li>JSON 不允许注释或尾随逗号。每个字符串是一条等权的文本检查，在最终回复中找到该文字即通过，英文字母大小写不影响匹配。</li>
        </ul>
        {setup.data && <CopyConfig path="codex-eval.json" value={setup.data.rules} />}
        <form className="page-stack" onSubmit={(event) => {
          event.preventDefault();
          if (description.trim() && !generated.isPending) generated.mutate(description.trim());
        }}>
          <label className="field-label">
            用自然语言生成规则
            <textarea value={description} maxLength={3000} required rows={3} disabled={generated.isPending}
              placeholder="例如：最终回复必须包含「测试结果」和「改动文件」这两个小标题。"
              onChange={(event) => {
                setDescription(event.target.value);
                generated.reset();
              }} />
          </label>
          <div>
            <button className="button" type="submit" disabled={!description.trim() || generated.isPending}>
              {generated.isPending ? "Codex 正在生成…" : "用 Codex 生成 JSON"}
            </button>
          </div>
          {generated.error && <p role="alert">{generated.error.message}</p>}
        </form>
        {generated.data && (
          <div className="page-stack">
            {generated.data.requiredText.length > 0 ? (
              <>
                <p>请核对生成的文字。确认后，把 JSON 复制到目标项目的配置文件。</p>
                <CopyConfig key={generated.submittedAt} path="codex-eval.json"
                  value={JSON.stringify({ requiredText: generated.data.requiredText, port }, null, 2)} />
              </>
            ) : <p>没有可用的文本规则。可以补充最终回复必须包含的原词或小标题，重新生成。</p>}
            {generated.data.unsupported.length > 0 && (
              <div>
                <p>以下目标需要其他检查方式，未纳入 JSON：</p>
                <ul>{generated.data.unsupported.map((item, index) => <li key={index}>{item}</li>)}</ul>
              </div>
            )}
          </div>
        )}
        <p>示例中的两项是「测试」和「通过」。「测试通过」得 100 分，只包含其中一项得 50 分。可在上方「Codex 评分记录」查看逐条结果。</p>
        <h3>3. 在 Codex 信任 Hook 并试跑</h3>
        <p>保持本机 Eval 服务运行，用 Codex 桌面端从该项目根目录开启对话。在输入框的 Review hooks 或 Settings → Hooks 审阅并信任 Hearth Eval 插件的 Stop Hook。先前添加过项目级 Hearth Stop Hook 时，可在此停用那一条。</p>
        <p>用示例规则时，发送「请只回复：测试通过」。本轮结束后，对话中应出现「Hearth 评分 100/100 · 文本检查通过 2/2」。</p>
        {setup.data && (
          <details>
            <summary>用项目级 Hook 接入</summary>
            <p>将下方配置保存到目标项目根目录。如果已有同名文件，将 <code>hooks.Stop</code> 条目追加到现有配置。然后审阅并信任项目级 Stop Hook。</p>
            <CopyConfig path=".codex/hooks.json" value={setup.data.hook} />
          </details>
        )}
      </div>
    </section>
  );
}
