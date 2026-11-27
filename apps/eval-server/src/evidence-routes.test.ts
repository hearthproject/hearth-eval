import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { EvidenceClient } from "./evidence-client.ts";
import type { EvalStore } from "./store.ts";
import { registerEvidenceRoutes } from "./evidence-routes.ts";

function fakeStore(cases: Map<string, Record<string, unknown>> = new Map()) {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  return {
    events,
    cases,
    appendEvent: vi.fn((type: string, input?: { payload?: Record<string, unknown> }) => {
      events.push({ type, ...(input?.payload ? { payload: input.payload } : {}) });
      return {};
    }),
    saveRegressionCase: vi.fn((input: { id: string; state: string; payload: Record<string, unknown> }) => {
      cases.set(input.id, { id: input.id, state: input.state, payload: input.payload });
    }),
    getRegressionCase: vi.fn((id: string) => cases.get(id) ?? null),
    listRegressionCases: vi.fn(() => [...cases.values()]),
    getExperimentManifest: vi.fn((id: string) => id === "exp-a" ? {
      schemaVersion: 1,
      kind: "hearth-experiment-manifest",
      experimentId: "exp-a",
      name: "a",
      createdAt: "2026-11-27T00:00:00.000Z",
      finalizedAt: null,
      repos: [],
      cases: { ids: ["c"], versions: { c: 1 }, catalogDigest: "d" },
      model: null,
      prompt: null,
      tools: null,
      context: null,
      approval: null,
      sandbox: null,
      judge: null,
      pricing: null,
      budget: null,
      variant: null,
      deps: null,
      environment: { hearthUrl: "x", hearthNow: null, schemaVersion: 1, instanceId: null, executorSettings: {}, judgeModel: null, evalVersion: "0" },
      compatibilityFingerprint: "",
      completeness: { status: "incomplete_provenance", missing: ["model"] }
    } : null),
    getExperiment: vi.fn(() => null),
    listRuns: vi.fn(() => []),
    getRunMetrics: vi.fn(() => null)
  } as unknown as EvalStore;
}

function fakeClient(): EvidenceClient {
  return {
    health: vi.fn(async () => ({ ok: true })),
    manifest: vi.fn(async () => ({
      schemaVersion: 1, kind: "hearth-runtime-manifest", contract: "hearth-evidence/1",
      runId: "run-1", taskId: "task-1", taskTitle: null, createdAt: "x", finalizedAt: null,
      repos: [], cases: null, model: null, prompt: null, tools: null, context: null,
      approval: null, sandbox: null, judge: null, pricing: null, budget: null, variant: null,
      deps: null, executorId: null, compatibilityFingerprint: "bad",
      completeness: { status: "incomplete_provenance", missing: ["model"] }
    })),
    replay: vi.fn(async () => ({
      report: {
        schemaVersion: 1, id: "r", baselineRunId: "run-1", candidateRunId: null, mode: "strict_replay",
        matched: true, firstDivergence: null, categories: {}, steps: [], providerCalls: 0,
        toolExecutions: 0, simulatedReceipts: 0, isolation: { workspace: "w", strictReplay: true },
        reproductionCommand: "c", createdAt: "x"
      },
      runId: "run-1"
    })),
    fork: vi.fn()
  } as unknown as EvidenceClient;
}

describe("evidence routes", () => {
  it("validates manifests and refuses a bad fingerprint", async () => {
    const app = Fastify({ logger: false });
    registerEvidenceRoutes(app, { store: fakeStore(), catalog: new Map(), repoRoot: ".", artifactRoot: ".hearth/eval-artifacts", client: fakeClient() });
    const response = await app.inject({ method: "GET", url: "/api/evidence/runs/run-1/manifest" });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe("INVALID_MANIFEST");
    await app.close();
  });

  it("compiles a failure into a persisted regression bundle", async () => {
    const store = fakeStore();
    const app = Fastify({ logger: false });
    registerEvidenceRoutes(app, { store, catalog: new Map(), repoRoot: ".", artifactRoot: ".hearth/eval-artifacts", client: fakeClient() });
    const response = await app.inject({
      method: "POST",
      url: "/api/evidence/failure-cases/compile",
      payload: { runId: "run-1", taskId: "task-1", title: "审批绕过", goal: "修复审批" }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { manifest: { id: string }; contract: { state: string } };
    expect(body.contract.state).toBe("pending");
    expect(store.saveRegressionCase).toHaveBeenCalled();
    const list = await app.inject({ method: "GET", url: "/api/evidence/failure-cases" });
    expect(list.json().cases.length).toBe(1);
    await app.close();
  });

  it("turns a strict replay with live calls into 409", async () => {
    const store = fakeStore();
    const client = fakeClient();
    client.replay = vi.fn(async () => ({
      report: {
        schemaVersion: 1, id: "r", baselineRunId: "run-1", candidateRunId: null, mode: "strict_replay",
        matched: false, firstDivergence: null, categories: {}, steps: [], providerCalls: 2,
        toolExecutions: 1, simulatedReceipts: 0, isolation: { workspace: "w", strictReplay: true },
        reproductionCommand: "c", createdAt: "x"
      },
      runId: "run-1"
    })) as unknown as EvidenceClient["replay"];
    const app = Fastify({ logger: false });
    registerEvidenceRoutes(app, { store, catalog: new Map(), repoRoot: ".", artifactRoot: ".hearth/eval-artifacts", client });
    const response = await app.inject({ method: "POST", url: "/api/evidence/replay", payload: { runId: "run-1" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain("strict replay");
    await app.close();
  });

  it("returns a validated experiment manifest", async () => {
    const app = Fastify({ logger: false });
    registerEvidenceRoutes(app, { store: fakeStore(), catalog: new Map(), repoRoot: ".", artifactRoot: ".hearth/eval-artifacts", client: fakeClient() });
    const response = await app.inject({ method: "GET", url: "/api/evidence/experiments/exp-a/manifest" });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe("INVALID_EXPERIMENT_MANIFEST");
    await app.close();
  });
});
