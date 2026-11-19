import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";

const tool = {
  name: "score_turn",
  description: "Score the final response using the project's local Hearth Eval rules.",
  inputSchema: {
    type: "object",
    required: ["cwd", "text"],
    properties: {
      cwd: { type: "string" },
      text: { type: ["string", "null"] },
      continued: { type: "boolean" },
      publish: { type: "boolean" }
    },
    additionalProperties: false
  }
};

async function score({ cwd, text, continued }) {
  if (continued === true || typeof cwd !== "string" || !isAbsolute(cwd) || typeof text !== "string" || !text.trim()) return {};
  try {
    const config = await readFile(join(cwd, "codex-eval.json"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return readFile(join(cwd, ".hearth", "codex-eval.json"), "utf8");
    });
    const { requiredText, port = 4318 } = JSON.parse(config.replace(/^\uFEFF/, ""));
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Array.isArray(requiredText) || !requiredText.length) {
      return { systemMessage: "Hearth 评分：请检查项目的 codex-eval.json。" };
    }
    if (text.length > 40_000) return { systemMessage: "Hearth 评分：本轮回复超过 40,000 字符。" };
    const response = await fetch(`http://127.0.0.1:${port}/api/codex/score-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, requiredText }),
      redirect: "error",
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) return { systemMessage: `Hearth 评分暂不可用（HTTP ${response.status}）。` };
    const { score, passed, total } = await response.json();
    return { systemMessage: `Hearth 评分 ${score}/100 · 文本检查通过 ${passed}/${total}` };
  } catch (error) {
    if (error.code === "ENOENT") return {};
    return { systemMessage: "Hearth 评分暂不可用。请检查本机 Eval 服务和项目配置。" };
  }
}

async function handle({ method, params }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "hearth-eval", version: "0.1.3" }
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: [tool] };
    case "tools/call": {
      if (params?.name !== tool.name) return { isError: true, content: [{ type: "text", text: "Unknown tool." }] };
      const args = params.arguments ?? {};
      const scored = await score(args);
      const result = args.publish === true && scored.systemMessage ? {
        decision: "block",
        reason: `这是任务完成后的 Hearth Eval 状态。请保留已经发送的任务回复，只追加下面这一行给用户，不要重新执行任务、调用工具或解释评分：\n${scored.systemMessage}`
      } : scored;
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    default:
      return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for await (const line of createInterface({ input: stdin })) {
    let request;
    try {
      request = JSON.parse(line);
      if (!request || !Object.hasOwn(request, "id")) continue;
      const result = await handle(request);
      const payload = result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result };
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...payload }) + "\n");
    } catch {
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32603, message: "Invalid MCP request" } }) + "\n");
    }
  }
}

export { score };
