#!/usr/bin/env node
import { open } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";

async function readArtifact(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 160_000) throw new Error("交付物必须是 160 KB 以内的普通文件。");
    const data = Buffer.alloc(160_001);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length === data.length) throw new Error("交付物超过 160 KB。");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, length));
    if (!text.trim() || text.length > 40_000 || text.includes("\0")) {
      throw new Error("交付物必须是 40,000 字符以内的非空 UTF-8 文本。");
    }
    return text;
  } finally {
    await file.close();
  }
}

async function submit(mode, flags) {
  const env = process.env;
  const hook = mode === "claude-stop";
  const id = flags["eval-id"] ?? env.HEARTH_EVAL_ID;
  if (hook && !id) return;
  const token = env.HEARTH_EVAL_TOKEN;
  const slot = Number(flags.slot ?? env.HEARTH_EVAL_SLOT);
  const file = flags.file ?? env.HEARTH_EVAL_FILE;
  let runId = flags["run-id"] ?? env.HEARTH_EVAL_RUN_ID;

  if (hook) {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    const event = JSON.parse(input);
    if (event.hook_event_name !== "Stop" || event.stop_hook_active) return;
    runId = event.session_id;
  }

  if (!id || !token || ![1, 2].includes(slot) || !file || typeof runId !== "string" || !runId.trim()) {
    throw new Error("请设置评测 ID、提交凭证、Agent 槽位、运行 ID 和交付物路径。");
  }
  let text;
  try {
    text = await readArtifact(file);
  } catch (error) {
    if (hook && error.code === "ENOENT") return;
    throw error;
  }

  const url = new URL(flags.url ?? env.HEARTH_EVAL_URL ?? "http://127.0.0.1:4318");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw new Error("Eval 服务须使用 HTTPS 或本机 HTTP 地址。");
  }
  const metadataFile = flags["metadata-file"] ?? env.HEARTH_EVAL_METADATA_FILE;
  const metadata = metadataFile ? JSON.parse(await readArtifact(metadataFile)) : undefined;
  const response = await fetch(new URL(`/api/imported-evaluations/${encodeURIComponent(id)}/submissions`, url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slot, runId, fileName: basename(file), text, metadata }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? `Eval 提交失败（HTTP ${response.status}）。`);
  if (!hook) console.log(JSON.stringify(body));
}

try {
  const [mode, ...args] = process.argv.slice(2);
  const flags = {};
  const allowedFlags = ["eval-id", "slot", "file", "run-id", "url", "metadata-file"];
  if (!["submit", "claude-stop"].includes(mode) || args.length % 2 || (mode === "claude-stop" && args.length)) {
    throw new Error("用法: hearth-eval submit [--eval-id ID] [--slot 1|2] [--file PATH] [--run-id ID] [--url URL] [--metadata-file PATH]");
  }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index].slice(2);
    if (!args[index].startsWith("--") || !allowedFlags.includes(flag) || flag in flags) {
      throw new Error(`未知或重复参数: ${args[index]}`);
    }
    flags[flag] = args[index + 1];
  }
  await submit(mode, flags);
} catch (error) {
  console.error(`hearth-eval: ${error.message}`);
  process.exitCode = 1;
}
