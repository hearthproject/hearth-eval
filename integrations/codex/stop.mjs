import process from "node:process";
import { score } from "./plugin/server.mjs";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
try {
  const event = JSON.parse(input);
  if (event.hook_event_name === "Stop") {
    const result = await score({
      cwd: process.cwd(),
      continued: event.stop_hook_active,
      text: event.last_assistant_message
    });
    if (result.systemMessage) console.log(JSON.stringify(result));
  }
} catch {
  console.log(JSON.stringify({ systemMessage: "Hearth 评分暂不可用。请检查本机 Eval 服务和项目配置。" }));
}
