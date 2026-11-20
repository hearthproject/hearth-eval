import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanOrders } from "./order-csv.ts";

export async function saveOrderAcceptance(root: string, source: { name: string; sha256: string; taskId: string }, result: ReturnType<typeof cleanOrders>, idColumn: string, amountColumn: string) {
  const directory = await mkdtemp(join(root, "订单验收-"));
  const csvPath = join(directory, "清洗后订单.csv");
  const reportPath = join(directory, "验收报告.md");
  try {
    await writeFile(csvPath, "\uFEFF" + result.csv, {flag:"wx"});
    const bytes = await readFile(csvPath);
    const verified = cleanOrders(new TextDecoder("utf-8",{fatal:true}).decode(bytes), idColumn, amountColumn);
    if (verified.removed.length || verified.csv !== result.csv || verified.retained !== result.retained) throw new Error("已保存 CSV 复核失败");
    const counts = new Map<string,number>();
    for (const row of result.removed) counts.set(row.reason,(counts.get(row.reason) ?? 0)+1);
    const report = [
      "# 订单 CSV 验收报告", "", "清洗后复核通过。", "",
      "任务 ID：" + source.taskId, "原始产物：" + source.name, "原始产物 SHA-256：" + source.sha256,
      "验收时间：" + new Date().toISOString(), "",
      "按 " + idColumn + " 保留首条有效订单，" + amountColumn + " 必须为大于零的十进制数。",
      "保留 " + result.retained + " 条，移除 " + result.removed.length + " 条。",
      ...Array.from(counts, ([reason,count]) => "- " + reason + "：" + count + " 条"), "",
      "[清洗后订单.csv](./清洗后订单.csv)", "清洗后文件 SHA-256：" + createHash("sha256").update(bytes).digest("hex"), ""
    ].join("\n");
    await writeFile(reportPath, report, {flag:"wx"});
    return directory;
  } catch (error) {
    await Promise.allSettled([unlink(csvPath),unlink(reportPath)]);
    await rmdir(directory);
    throw error;
  }
}
