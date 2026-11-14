import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ScenarioSelfCheckService } from "./scenario-self-check.ts";

describe("scenario self-check", () => {
  it.each([0, 1, 2])("reports exit %s, cleans temporary files and keeps logs in memory", async (exitCode) => {
    const root = mkdtempSync(join(tmpdir(), "self-check-test-"));
    const service = new ScenarioSelfCheckService(root);
    onTestFinished(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
    mkdirSync(join(root, "eval/scenarios"), { recursive: true });
    mkdirSync(join(root, "scenario-runner"));
    writeFileSync(join(root, "eval/scenarios/scenarios.json"), readFileSync(new URL("../../../eval/scenarios/scenarios.json", import.meta.url)));
    writeFileSync(join(root, "scenario-runner/tsconfig.json"), "{}");
    writeFileSync(join(root, "scenario-runner/run-scenarios.ts"), `
      console.log('ROOT ' + process.env.HEARTH_SELF_CHECK_ROOT);
      setTimeout(() => {
        if (${exitCode} < 2) console.log('HEARTH_SELF_CHECK_RESULT ' + JSON.stringify({
          markdown:'# log',
          report: {version:1, startedAt:new Date().toISOString(), completedAt:new Date().toISOString(), runs:[1,2,3].map(repetition => ({
            scenarioId:'action-binding-tamper', title:'动作绑定', mechanism:'action_resolver', priority:'P0', fault:'tamper',
            repetition, status:'${exitCode === 0 ? "passed" : "failed"}', durationMs:1, evidencePath:'temporary', error:null,
            assertions:[{name:'native-waiter-released', passed:${exitCode === 0}, detail:'审批等待检查'}]
          }))}, evidence:{'action-binding-tamper/1':{checked:true}}
        }));
        process.exit(${exitCode});
      }, 50);
    `);
    await expect(service.start("unknown")).rejects.toThrow("找不到");
    expect((await service.start("action-binding-tamper")).status).toBe("running");
    await expect(service.start()).rejects.toThrow("正在运行");
    await expect.poll(() => service.snapshot().status, { timeout: 15_000 }).not.toBe("running");
    const result = service.snapshot();
    expect(result.status).toBe(["passed", "failed", "error"][exitCode]);
    expect(result.markdown).toBeTruthy();
    const temporaryRoot = result.output.split("\n").find((line) => line.startsWith("ROOT "))!.slice(5);
    expect(existsSync(temporaryRoot)).toBe(false);
    expect(existsSync(join(root, "eval/scenario-runs"))).toBe(false);
    expect(existsSync(join(root, "log.md"))).toBe(false);
    if (exitCode < 2) {
      expect(service.batch()).toMatchObject({ id: result.batchId, total: 3, passed: exitCode === 0 ? 3 : 0 });
      expect(service.evidence(result.batchId!, "action-binding-tamper", "1")).toEqual({ checked: true });
      expect(service.batch()?.runs[0]?.assertions[0]?.name).toBe("native-waiter-released");
      await service.start();
      expect(service.batch()?.id).toBe(result.batchId);
      await expect.poll(() => service.snapshot().status, { timeout: 15_000 }).not.toBe("running");
      expect(service.batch()?.id).not.toBe(result.batchId);
      expect(service.evidence(result.batchId!, "action-binding-tamper", "1")).toBeNull();
    } else {
      expect(service.batch()).toBeNull();
    }
  }, 20_000);
});
