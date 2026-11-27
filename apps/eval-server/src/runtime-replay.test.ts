import { describe, expect, it, vi } from "vitest";
import type { DivergenceReport } from "@hearth/eval-core";
import type { EvidenceClient } from "./evidence-client.ts";
import { evidenceGaps, forkAtCheckpoint, loadRunEvidence, replayRun } from "./runtime-replay.ts";

function report(partial: Partial<DivergenceReport> = {}): DivergenceReport {
  return {
    schemaVersion: 1,
    id: "report-1",
    cassetteId: "cassette:run-1",
    candidateRunId: "run-1",
    mode: "strict_replay",
    matched: true,
    totalRecordedSteps: 3,
    totalCandidateSteps: 3,
    firstDivergence: null,
    categories: {},
    providerCalls: 0,
    toolExecutions: 0,
    simulatedReceipts: 3,
    termination: { recorded: null, candidate: {} },
    recordedSteps: [],
    candidateSteps: [],
    origin: "replay",
    parentRunId: null,
    checkpointSeq: null,
    reproductionCommand: "curl ...",
    generatedAt: "2026-11-27T00:00:00.000Z",
    ...partial
  };
}

function fakeClient(overrides: Partial<Record<keyof EvidenceClient, unknown>> = {}): EvidenceClient {
  return {
    replay: vi.fn(async () => ({ report: report(), run: { id: "run-1", status: "completed", finalResponse: "", usage: null, turns: 1, toolCalls: 0, failure: null }, workspace: "/tmp" })),
    fork: vi.fn(async () => ({
      run: { id: "fork-1", status: "completed", finalResponse: "", usage: null, turns: 1, toolCalls: 1, failure: null },
      workspace: "/tmp/fork",
      forkRunId: "fork-1",
      report: report({ origin: "checkpoint_fork", parentRunId: "run-1", checkpointSeq: 3, firstDivergence: { category: "tool_result", index: 2, expected: null, actual: null, detail: {} } })
    })),
    manifest: vi.fn(async () => ({ completeness: { status: "complete", missing: [] } })),
    exchanges: vi.fn(async () => ({ exchanges: [] })),
    cost: vi.fn(async () => ({ entries: [], statuses: [] })),
    ...overrides
  } as unknown as EvidenceClient;
}

describe("runtime replay orchestration", () => {
  it("derives cassette id and rejects a strict replay that made live calls", async () => {
    const replay = vi.fn(async () => ({ report: report({ providerCalls: 1 }), run: { id: "run-1", status: "failed", finalResponse: "", usage: null, turns: 1, toolCalls: 0, failure: null }, workspace: "/tmp" }));
    await expect(replayRun(fakeClient({ replay }), "run-1")).rejects.toThrow("strict replay 发生了真实调用");
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({ cassetteId: "cassette:run-1", mode: "strict_replay" }));
  });

  it("classifies a divergence and keeps the reproduction command", async () => {
    const replay = vi.fn(async () => ({ report: report({ firstDivergence: { category: "system_prompt", index: 1, expected: null, actual: null, detail: {} } }), run: { id: "run-1", status: "completed", finalResponse: "", usage: null, turns: 1, toolCalls: 0, failure: null }, workspace: "/tmp" }));
    const result = await replayRun(fakeClient({ replay }), "run-1", { mode: "live_on_divergence" });
    expect(result.divergenceClass).toBe("prompt_serialization");
    expect(result.reproductionCommand).toBe("curl ...");
    expect(result.strict).toBe(false);
  });

  it("forks from a checkpoint and maps the class", async () => {
    const result = await forkAtCheckpoint(fakeClient(), { runId: "run-1", checkpointSeq: 3 });
    expect(result.forkRunId).toBe("fork-1");
    expect(result.divergenceClass).toBe("tool_result");
    expect(result.status).toBe("completed");
  });

  it("lists evidence gaps instead of pretending completeness", async () => {
    const bundle = await loadRunEvidence(fakeClient(), "run-1", "task-1");
    expect(bundle.cost).toEqual({ entries: [], statuses: [] });
    expect(evidenceGaps(bundle)).toContain("cassette.exchanges");
    expect(evidenceGaps(bundle)).toContain("cassette.model.request");
  });
});
