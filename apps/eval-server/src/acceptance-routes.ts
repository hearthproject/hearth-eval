import { Readable } from "node:stream";
import { parseCsv } from "@hearth/eval-core";
import type { LocalJudge } from "./local-judge.ts";
import { saveOrderAcceptance } from "./order-delivery.ts";
import { cleanOrders } from "./order-csv.ts";
import { z } from "zod";
import type { JudgeAdapter } from "./judge-adapter.ts";
import { reviewAcceptance } from "./acceptance-review.ts";
import { HearthAcceptanceExecutor } from "./acceptance-executor.ts";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AcceptanceDefaults, AcceptanceJob, CsvReportRow } from "@hearth/eval-core";
import { AcceptanceAgent, acceptanceInputSchema } from "./acceptance-agent.ts";

export async function registerAcceptanceRoutes(app: FastifyInstance, agent: AcceptanceAgent, hearthUrl: string, judge?: JudgeAdapter & Partial<Pick<LocalJudge,"csvLabels">>) {
  await app.register(async local => {
    local.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const origin = URL.parse(request.headers.origin ?? "");
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) ||
        (request.headers.origin && (!origin || !["http:", "https:"].includes(origin.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
        return reply.code(403).send({ message: "交付验收仅允许本机操作" });
      }
    });
    local.setErrorHandler((error, _request, reply) => reply.code(400).send({ message: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join("；") : error instanceof Error ? error.message : "验收操作失败" }));
    const hearth = new HearthAcceptanceExecutor(hearthUrl);
    local.get("/api/acceptance/hearth/tasks", () => hearth.listTasks());
    local.get<{ Params: { id: string } }>("/api/acceptance/hearth/tasks/:id", request => hearth.taskOutputs(request.params.id));
    local.post<{ Params: { id: string } }>("/api/acceptance/hearth/tasks/:id/csv-labels", async request => {
      const input = z.object({name:z.string().regex(/\.csv$/i),artifactId:z.string()}).parse(request.body);
      const artifact = await hearth.artifact(request.params.id,input.name);
      if (!artifact || artifact.artifactId !== input.artifactId) throw new Error("CSV 产物已变化");
      const headers = parseCsv(new TextDecoder("utf-8",{fatal:true}).decode(artifact.bytes))[0]?.map(h=>h.trim()) ?? [];
      if (headers.length < 2 || headers.join("").length > 8000) throw new Error("表头不适合自动识别");
      try {
        if (!judge?.csvLabels) throw new Error("评委未配置");
        return {headers,...await judge.csvLabels(headers)};
      } catch {
        return {headers,title:input.name,idLabel:"去重依据",amountLabel:"数值校验依据",idColumn:"",amountColumn:"",warning:"自动识别不可用，请手动选择实际列"};
      }
    });
    local.post<{ Params: { id: string } }>("/api/acceptance/hearth/tasks/:id/orders", async (request,reply) => {
      const input = z.object({ name: z.string().max(300).regex(/\.csv$/i), artifactId: z.string().min(1), idColumn: z.string().trim().min(1), amountColumn: z.string().trim().min(1), repair: z.boolean().default(true), review: z.object({memoryKey:z.string().min(1),revision:z.number().int().positive(),requirements:z.string().trim().min(1).max(500)}).optional() }).parse(request.body);
      const id = randomUUID(), now = new Date().toISOString();
      const report: NonNullable<AcceptanceJob["csvReport"]> = {taskId:request.params.id, rows:[]};
      const job: AcceptanceJob = {id, createdAt:now, updatedAt:now, executor:"hearth", executorUrl:hearthUrl,
        desktopRoot:agent.root(), targetPath:"", attempts:[], status:"running", error:null, csvReport:report,
        input:{requestId:id,fileName:input.name,title:input.name,requiredText:[],maxRepairs:input.repair?1:0}};
      async function* execute() {
      const row = (id:string,title:string,state:CsvReportRow["state"],detail="") => ({row:{id,title,state,detail}});
      yield row("file","输出文件存在且可读取","PENDING");
      const artifact = await hearth.artifact(request.params.id, input.name);
      if (!artifact || artifact.artifactId !== input.artifactId) throw new Error("所选 CSV 已变化，请刷新产物列表");
      const original = new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
      const result = cleanOrders(original, input.idColumn, input.amountColumn);
      const settings = input.review;
      const memory = settings ? agent.memory(settings.memoryKey).memory : null;
      if (settings && (!judge || !memory || memory.revision !== settings.revision)) throw new Error("评委不可用或共享记忆版本已变化，请刷新");
      async function assess(csv: string) {
        if (!settings || !memory || !judge) return null;
        const response = await judge.judge({
          criteria: [{id:"orders", label:"订单 CSV 语义评审", points:1, rubric:"按共享背景与用户要求检查 CSV。通过时引用实际 CSV 的逐字证据。"}],
          deterministic: [], artifacts: Object.fromEntries(Object.entries({ "orders.csv":csv, "context.txt":memory.content, "requirements.txt":settings.requirements }).map(([key,text])=>[key,{text,bytes:Buffer.byteLength(text)}]))
        });
        const item = response.criteria.find(c=>c.id==="orders");
        if (!item || item.evidence.some(q=>!q.trim() || !csv.includes(q)) || (item.passed && (!item.evidence.length || item.confidence<0.7))) throw new Error("CSV 语义评审证据不足，无法判断");
        return item;
      }
      yield row("file","输出文件存在且可读取","PASS",input.name);
      const rules = [
        {id:"duplicate",title:`按 ${input.idColumn} 正确去重`,reason:"重复订单"},
        {id:"amount",title:`${input.amountColumn} 金额有效`,reason:"无效金额"},
        {id:"id",title:"订单号完整",reason:"缺少订单号"}
      ];
      for (const rule of rules) {
        const issues=result.removed.filter(item=>item.reason===rule.reason);
        yield row(rule.id,rule.title,issues.length?"FAIL":"PASS",issues.length ? `发现 ${issues.length} 条，首个问题在记录 ${issues[0]!.record}` : "首轮检查通过");
      }
      if(settings) yield row("semantic","内容符合验收要求","PENDING");
      const first = await assess(original);
      if(first) yield row("semantic","内容符合验收要求",first.passed?"PASS":"FAIL",first.reason);
      const repaired = result.removed.length > 0 || first?.passed === false;
      if (repaired && !input.repair) throw new Error(`首次验收未通过：需移除 ${result.removed.length} 条记录。${first?.reason ?? ""} 本次未启用修复。`);
      if (repaired) {
        yield row("repair","清洗并复验","PENDING");
        if(settings) yield row("semantic","内容符合验收要求","PENDING","正在复验清洗后的文件");
      }
      const final = repaired ? await assess(result.csv) : first;
      if(final) yield row("semantic","内容符合验收要求",final.passed?"PASS":"FAIL",final.reason);
      if (final && !final.passed) throw new Error("一次清洗修复后复验未通过：" + final.reason);
      yield row("output","验收文件已保存且可读取","PENDING");
      const directory = await saveOrderAcceptance(agent.root(), { name: input.name, sha256: artifact.sha256, taskId: request.params.id }, result, input.idColumn, input.amountColumn);
      if(repaired) {
        for(const rule of rules) yield row(rule.id,rule.title,"PASS","回读清洗后的 CSV，复验通过");
        yield row("repair","清洗并复验","PASS",`移除 ${result.removed.length} 条，保留 ${result.retained} 条`);
      }
      yield row("output","验收文件已保存且可读取","PASS",directory);
      yield {result:{ ...result, sha256: artifact.sha256, directory, repaired, review: final?.reason ?? null }};
      }
      async function* recorded() {
        agent.saveCsvRecord(job);
        try {
          for await (const event of execute()) {
            if ("row" in event) {
              const index=report.rows.findIndex(item=>item.id===event.row.id);
              if(index<0) report.rows.push(event.row); else report.rows[index]=event.row;
            } else {
              const r=event.result;
              Object.assign(report,{directory:r.directory,sha256:r.sha256,retained:r.retained,removed:r.removed.length});
              job.targetPath=r.directory;
              job.status="passed";
            }
            agent.saveCsvRecord(job);
            yield event;
          }
        } catch(error) {
          job.status=report.rows.some(row=>row.state==="FAIL")?"failed":"error";
          job.error=error instanceof Error?error.message:"验收失败";
          throw error;
        } finally {
          if(job.status==="running") job.status="interrupted";
          for(const row of report.rows) if(row.state==="PENDING") row.state="INCONCLUSIVE";
          agent.saveCsvRecord(job);
        }
      }
      if (request.headers.accept === "application/x-ndjson") {
        async function* lines() {
          try { for await (const event of recorded()) yield JSON.stringify(event)+"\n"; }
          catch(error) { yield JSON.stringify({error:error instanceof Error ? error.message : "验收失败"})+"\n"; }
        }
        return reply.header("X-Accel-Buffering","no").type("application/x-ndjson").send(Readable.from(lines()));
      }
      for await (const event of recorded()) if ("result" in event) return event.result;
    });
    local.post<{ Params: { id: string } }>("/api/acceptance/hearth/tasks/:id/check", async request => {
      const input = z.object({ name: z.string().min(1), artifactId: z.string().min(1), required: z.string().trim().min(1).max(500), memoryKey: z.string().trim().max(64) }).parse(request.body);
      const id = request.params.id;
      const original = agent.list().find(job => job.executorUrl === hearthUrl && job.attempts.some(attempt => attempt.taskId === id));
      const memory = input.memoryKey ? agent.memory(input.memoryKey).memory : null;
      if (input.memoryKey && !memory) throw new Error("项目记忆不存在");
      const snapshot = memory ? { ...memory, capturedAt: new Date().toISOString() } : original?.contextSnapshot;
      const output = await hearth.artifact(id, input.name);
      if (!output || output.artifactId !== input.artifactId) throw new Error("产物已变化，请刷新");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(output.bytes);
      if (!text.trim()) throw new Error("产物为空");
      if (snapshot && !judge) throw new Error("评委不可用");
      const goal = (await hearth.taskOutputs(id)).goal;
      const semantic = snapshot && judge ? await reviewAcceptance(judge, { contextSnapshot: snapshot, input: { semanticRequirements: goal + "\n" + input.required } }, text, output.sha256) : null;
      const missing = input.required.split(/\r?\n/).map(line => line.trim()).filter(line => line && !text.includes(line));
      return { passed: !missing.length && (!semantic || semantic.passed), missing, sha256: output.sha256, semantic, snapshot };
    });
    local.get("/api/acceptance/defaults", async (): Promise<AcceptanceDefaults> => ({ desktopRoot: agent.root(),
      fileName: `hearth-acceptance-${randomUUID().slice(0, 8)}.md`, title: "Hearth 交付验收", requiredText: ["这是由 Hearth OS 生成的 Markdown 文件。", "执行与验收分离。"], hearthUrl }));
    local.get<{ Params: { id: string } }>("/api/acceptance/:id/events", async (request, reply) => {
      const id = request.params.id;
      agent.get(id);
      reply.hijack();
      const stream = reply.raw;
      stream.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      let previous = "";
      const publish = () => {
        const job = agent.get(id);
        const payload = JSON.stringify(job);
        if (payload !== previous) stream.write(`data: ${payload}\n\n`);
        previous = payload;
        if (!["running", "waiting_approval", "waiting_input"].includes(job.status)) stream.end();
      };
      const timer = setInterval(publish, 500);
      stream.once("close", () => clearInterval(timer));
      publish();
    });
    local.post("/api/acceptance/metrics/accuracy", async request => {
      const entries=z.array(z.object({id:z.string().uuid(),correct:z.boolean()})).min(1).max(100).parse(request.body);
      if(new Set(entries.map(e=>e.id)).size!==entries.length) throw new Error("任务重复");
      return agent.submitAccuracy(entries);
    });
    local.get("/api/acceptance/metrics/accuracy", async () => agent.accuracy());
    local.put<{Params:{id:string}}>("/api/acceptance/:id/reference", async request => {
      const {verdict} = z.object({verdict:z.enum(["passed","failed"])}).parse(request.body);
      return agent.setReference(request.params.id,verdict);
    });
    local.get("/api/acceptance", async () => agent.list().slice(0, 100));
    local.get<{ Params: { key: string } }>("/api/acceptance/memory/:key", async request => agent.memory(request.params.key));
    local.put<{ Params: { key: string } }>("/api/acceptance/memory/:key", async request => agent.saveMemory(request.params.key, request.body));
    local.get<{ Params: { id: string } }>("/api/acceptance/:id", async request => agent.get(request.params.id));
    local.post("/api/acceptance", async (request, reply) => {
      const input = acceptanceInputSchema.parse(request.body);
      await agent.checkReviewer(input);
      let goal: string | undefined;
      if (input.source) {
        const previous = agent.list().find(job => job.id === input.requestId);
        if (previous) return reply.code(202).send(agent.start(input));
        const outputs = await hearth.taskOutputs(input.source.taskId);
        if (!outputs.artifacts.some(a => a.id === input.source!.artifactId && a.name === input.source!.name)) throw new Error("所选任务没有此产物");
        goal = outputs.goal;
      }
      return reply.code(202).send(agent.start(input, goal));
    });
    local.post<{ Params: { id: string } }>("/api/acceptance/:id/resume", async request => agent.resume(request.params.id));
    local.post<{ Params: { id: string } }>("/api/acceptance/:id/stop", async request => agent.stop(request.params.id));
  });
}
