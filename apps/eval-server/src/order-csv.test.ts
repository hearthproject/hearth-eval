import { expect,it } from "vitest";
import { cleanOrders } from "./order-csv.ts";
it("retains the first valid order and preserves quoted multiline fields",()=>{
  const result=cleanOrders('\uFEFForder_id,amount,note\r\n001,NaN,x\r\n001,12.30,"a,b\nc"\r\n001,99,x\r\n002,-1,x\r\n003,0,x\r\n004,,x\r\n');
  expect(result.retained).toBe(1);
  expect(result.removed.map(row=>row.reason)).toEqual(["无效金额","重复订单","无效金额","无效金额","无效金额"]);
  expect(result.csv).toContain('001,12.30,"a,b\nc"');
  expect(cleanOrders(result.csv).removed).toEqual([]);
});
it("rejects structurally invalid input instead of silently discarding orders",()=>{
  expect(()=>cleanOrders('order_id,amount\n"open,10')).toThrow();
  expect(()=>cleanOrders("order_id,amount\n1,3,extra")).toThrow();
  expect(cleanOrders("id,value\n1,3","id","value").retained).toBe(1);
});


it("saves two verified delivery files in a fresh directory and preserves source bytes", async()=>{
  const {mkdtemp,readFile,readdir,writeFile,rm}=await import("node:fs/promises");
  const {join}=await import("node:path");
  const {tmpdir}=await import("node:os");
  const {createHash}=await import("node:crypto");
  const {saveOrderAcceptance}=await import("./order-delivery.ts");
  const root=await mkdtemp(join(tmpdir(),"order-delivery-test-"));
  try {
    const original=Buffer.from("order_id,amount\n1,2\n1,4\n2,-1\n");
    const source=join(root,"orders.csv");
    await writeFile(source,original);
    const info={name:"orders.csv",taskId:"test",sha256:createHash("sha256").update(original).digest("hex")};
    const result=cleanOrders((await readFile(source)).toString());
    const directory=await saveOrderAcceptance(root,info,result,"order_id","amount");
    expect((await readdir(directory)).sort()).toEqual(["清洗后订单.csv","验收报告.md"].sort());
    expect(await readFile(join(directory,"清洗后订单.csv"),"utf8")).toBe("\uFEFForder_id,amount\r\n1,2\r\n");
    expect(await readFile(join(directory,"验收报告.md"),"utf8")).toContain(info.sha256);
    expect(await readFile(source)).toEqual(original);
    expect(await saveOrderAcceptance(root,info,result,"order_id","amount")).not.toBe(directory);
  } finally {await rm(root,{recursive:true,force:true});}
});
