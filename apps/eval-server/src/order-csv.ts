import { parseCsv } from "@hearth/eval-core";

export function cleanOrders(text: string, idColumn = "order_id", amountColumn = "amount") {
  const source = text.replace(/^\uFEFF/, "");
  // Validate quoting before using the shared CSV reader.
  const field = /(?:"(?:[^"]|"")*"|[^",\r\n]*)(,|\r?\n|$)/y;
  let offset = 0;
  while (offset < source.length) {
    field.lastIndex = offset;
    const match = field.exec(source);
    if (!match || field.lastIndex <= offset) throw new Error("CSV 引号或换行格式无效");
    offset = field.lastIndex;
  }
  const [header, ...records] = parseCsv(source);
  const names = header?.map(value => value.trim()) ?? [];
  const idIndex = names.indexOf(idColumn), amountIndex = names.indexOf(amountColumn);
  if (!header || idIndex < 0 || amountIndex < 0 || idIndex === amountIndex || new Set(names).size !== names.length)
    throw new Error("请确认订单号列与金额列存在、不同，且表头没有重名");
  const seen = new Set<string>();
  const kept = [header];
  const removed: Array<{record:number; id:string; reason:string}> = [];
  for (const [index,row] of records.entries()) {
    if (row.length === 1 && row[0] === "") continue;
    if (row.length !== header.length) throw new Error(`第 ${index+1} 条记录列数与表头不一致`);
    const id = row[idIndex]!.trim(), amount = row[amountIndex]!.trim();
    let reason = "";
    if (!id) reason = "缺少订单号";
    else if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0) reason = "无效金额";
    else if (seen.has(id)) reason = "重复订单";
    if (reason) removed.push({record:index+1,id,reason});
    else {seen.add(id); kept.push(row);}
  }
  const csv = kept.map(row => row.map(value => /[",\r\n]/.test(value) ? '"' + value.replace(/"/g,'""') + '"' : value).join(",")).join("\r\n") + "\r\n";
  return { retained: kept.length-1, removed, csv };
}
