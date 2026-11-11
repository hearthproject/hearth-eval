import type { JudgeResponse } from "@hearth/eval-core";
import { describe, expect, it, vi } from "vitest";
import { HearthClient } from "./hearth-client.ts";
import { HearthJudgeAdapter } from "./judge-adapter.ts";

describe("Hearth judge compatibility", () => {
  it("sends the existing task-based HTTP payload and preserves the result", async () => {
    const result: JudgeResponse = {
      model: "hearth-judge", promptHash: "a".repeat(64),
      criteria: [{ id: "quality", passed: true, confidence: 0.9, reason: "Clear", evidence: ["reply"] }],
      overallConfidence: 0.9, usage: { inputTokens: 10, outputTokens: 5 }
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(result), { status: 200 }));
    const judge = new HearthJudgeAdapter(new HearthClient({ baseUrl: "http://hearth.invalid", fetchImpl }));
    const body = {
      taskId: "task-1", criteria: [{ id: "quality", label: "Quality", rubric: "Clear reply", points: 30 }],
      deterministic: [{ criterionId: "exists", passed: true, reason: "File exists" }], locale: "en"
    };
    await expect(judge.judge({
      ...body, artifacts: { "result.md": { text: "reply", bytes: 5 } }
    })).resolves.toEqual(result);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://hearth.invalid/api/eval/judge");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(body);
  });

  it("rejects artifacts without a Hearth task instead of using an unrelated task", () => {
    const client = { judge: vi.fn() };
    const judge = new HearthJudgeAdapter(client);
    expect(() => judge.judge({ artifacts: {}, criteria: [], deterministic: [] })).toThrow("任务 ID");
    expect(client.judge).not.toHaveBeenCalled();
  });
});
