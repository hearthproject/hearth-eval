import { describe, expect, it } from "vitest";
import { observeTrace, parseCsv, runGrader, runTraceGrader } from "./graders.ts";
import type { ArtifactMap, EvalTrace, GraderSpec } from "./types.ts";

const artifacts: ArtifactMap = {
  "notes.md": { text: "项目结论\n负责人：张三\n", bytes: 24 },
  "result.json": { text: JSON.stringify({ status: "ok", items: [{ id: 1 }, { id: 2 }] }), bytes: 48 },
  "rows.csv": { text: "name,amount\nA,10\nB,20\n", bytes: 24 }
};

function grade(spec: GraderSpec) {
  return runGrader(spec, artifacts);
}

describe("runGrader", () => {
  it("checks text includes and excludes", () => {
    expect(grade({ id: "t", title: "text", config: { kind: "text", path: "notes.md", includes: ["项目结论", "张三"], excludes: ["待补充"] } }).passed).toBe(true);
    expect(grade({ id: "t", title: "text", config: { kind: "text", path: "notes.md", excludes: ["项目结论"] } }).passed).toBe(false);
  });

  it("checks JSON paths, values and array lengths", () => {
    const result = grade({
      id: "j",
      title: "json",
      config: { kind: "json", path: "result.json", requiredPaths: ["status", "items.1.id"], equals: { status: "ok" }, minArrayLength: { items: 2 } }
    });
    expect(result.passed).toBe(true);
  });

  it("checks CSV columns and values", () => {
    const result = grade({
      id: "c",
      title: "csv",
      config: { kind: "csv", path: "rows.csv", requiredColumns: ["name", "amount"], minRows: 2, requiredValues: [{ column: "name", equals: "B" }] }
    });
    expect(result.passed).toBe(true);
  });

  it("returns a useful failure for missing artifacts", () => {
    const result = grade({ id: "f", title: "file", config: { kind: "file", path: "missing.md" } });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("missing.md");
  });

  it("parses quoted CSV cells", () => {
    expect(parseCsv('name,note\nA,"x, y"\n')).toEqual([["name", "note"], ["A", "x, y"]]);
  });

  it("refuses to run a trace grader against artifacts only", () => {
    const result = grade({ id: "tr", title: "trace", config: { kind: "trace", maxSteps: 5 } });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("trace");
  });
});

const trace: EvalTrace = {
  taskId: "task-1",
  fetchedAt: "2026-11-17T00:00:00.000Z",
  events: [],
  truncated: false,
  steps: 6,
  toolCalls: 3,
  approvals: 1,
  effects: 2,
  artifacts: 1,
  errors: [{ seq: 9, message: "boom" }],
  primaryCause: "none"
};

describe("runTraceGrader", () => {
  it("passes when every observed metric is inside the limits", () => {
    const result = runTraceGrader(
      { id: "tr", title: "trace", config: { kind: "trace", maxSteps: 6, maxToolCalls: 3, minApprovals: 1, minEffects: 2, maxEffects: 2, requireNoErrors: false } },
      trace
    );
    expect(result.passed).toBe(true);
  });

  it("fails on max steps, tool calls, approvals and effects", () => {
    const result = runTraceGrader(
      { id: "tr", title: "trace", config: { kind: "trace", maxSteps: 5, maxToolCalls: 2, minApprovals: 2, minEffects: 3 } },
      trace
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("steps");
    expect(result.reason).toContain("toolCalls");
    expect(result.reason).toContain("审批");
    expect(result.reason).toContain("效果");
  });

  it("fails when errors are forbidden or a measured value is missing", () => {
    const errors = runTraceGrader({ id: "tr", title: "trace", config: { kind: "trace", requireNoErrors: true } }, trace);
    expect(errors.passed).toBe(false);
    expect(observeTrace(trace)).toMatchObject({ steps: 6, toolCalls: 3, approvals: 1, effects: 2, errors: 1, durationMs: null, tokens: null });
    const missing = runTraceGrader({ id: "tr", title: "trace", config: { kind: "trace", maxDurationMs: 1000 } }, trace);
    expect(missing.passed).toBe(false);
    expect(missing.reason).toContain("无观测值");
  });
});
