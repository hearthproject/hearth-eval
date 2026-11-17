import { describe, expect, it } from "vitest";
import { attributePrimaryCause, buildEvalTrace, phaseOf } from "./trace.ts";

describe("buildEvalTrace", () => {
  it("orders events by seq, deduplicates and counts phases", () => {
    const trace = buildEvalTrace("task-1", [
      { seq: 3, type: "effect.created", payload: { status: "succeeded" } },
      { seq: 1, type: "task.created", payload: {} },
      { seq: 2, type: "approval.created", payload: { status: "pending" } },
      { seq: 2, type: "approval.created", payload: { status: "pending" } }
    ]);
    expect(trace.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(trace.events.map((event) => event.step)).toEqual([1, 2, 3]);
    expect(trace.approvals).toBe(1);
    expect(trace.effects).toBe(1);
    expect(trace.primaryCause).toBe("none");
  });

  it("attributes approval rejection before other causes", () => {
    const trace = buildEvalTrace("task-2", [
      { seq: 1, type: "approval.created", payload: { status: "pending" } },
      { seq: 2, type: "approval.updated", payload: { status: "rejected" } },
      { seq: 3, type: "run.failed", payload: { error: "任务超时" } }
    ], { taskStatus: "failed" });
    expect(trace.primaryCause).toBe("approval_blocked");
    expect(trace.errors.length).toBeGreaterThan(0);
  });

  it("attributes policy denials, timeouts and missing artifacts", () => {
    expect(attributePrimaryCause([
      { seq: 1, type: "run.error", runId: null, step: 1, phase: "error", payload: { error: "policy denied" }, createdAt: "" }
    ])).toBe("policy_denied");
    expect(attributePrimaryCause([
      { seq: 1, type: "run.error", runId: null, step: 1, phase: "error", payload: { error: "请求超时" }, createdAt: "" }
    ])).toBe("task_timeout");
    expect(attributePrimaryCause([], { error: "期望产物缺失" })).toBe("unknown");
    expect(attributePrimaryCause([
      { seq: 1, type: "run.error", runId: null, step: 1, phase: "error", payload: {}, createdAt: "" }
    ], { error: "期望产物缺失" })).toBe("artifact_missing");
  });

  it("maps event types to phases", () => {
    expect(phaseOf("approval.created")).toBe("approval");
    expect(phaseOf("effect.updated")).toBe("effect");
    expect(phaseOf("artifact.published")).toBe("artifact");
    expect(phaseOf("outbox.updated")).toBe("outbox");
    expect(phaseOf("run.failed")).toBe("error");
    expect(phaseOf("task.updated")).toBe("run");
  });
});
